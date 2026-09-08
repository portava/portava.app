/**
 * LayoverSafeReturnCard — §15 Safe Return posture and §15.1 the one-tap abort.
 *
 * ── WHAT THIS SURFACES, AND FROM WHERE ───────────────────────────────────────
 *   overview.safeReturn      → the posture headline and the abort control
 *   overview.offlineBundle   → whether the deadline may be shown as live truth
 *   overview.certification   → when the answer was computed, and by which rules
 *   POST …/return-now        → the return contract the abort hands back
 *
 * ── THE FAILURE PATH IS NOT AN ERROR PATH ────────────────────────────────────
 * A half-failed abort answers 500 with `ok:false` and STILL carries
 * `returnContract` + `posture`. This component renders the contract on that
 * path exactly as it does on success, with the server's message above it. The
 * one instruction that must survive a partial failure is "head to the airport
 * now", and a generic error toast destroys it.
 *
 * ── STALENESS IS A LABEL, NOT A HIDE ─────────────────────────────────────────
 * Past `offlineBundle.staleAfter` the deadline is captioned as LAST CERTIFIED
 * with its age. It is never removed: an old deadline the traveller can judge
 * beats no deadline. See layoverReturnFacts.describeDeadline.
 *
 * ── NOT DECIDED HERE ─────────────────────────────────────────────────────────
 * LAYOVER_RETURN_REMINDER_DELIVERY (server-push vs client-scheduled) is
 * untouched: this component neither schedules nor requests a notification. The
 * dashboard's existing "Remind me" owns that, unchanged.
 */
import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { AlertTriangle, CheckCircle2, Clock, Plane, WifiOff } from 'lucide-react-native';
import { color, radius, space, type as t } from '../../theme/tokens.ts';
import {
  returnToAirportNow,
  type LayoverOverview,
  type ReturnContract,
  type ReturnNowOutcome,
  type SafeReturnPosture,
} from '../../services/layover.ts';
import {
  describeAbortEffects,
  describeDeadline,
  postureHeadline,
  statusCapabilityNote,
  summarizeCertification,
  type PostureTone,
} from './layoverReturnFacts.ts';
import { fmtClock, fmtDur } from './layoverFormat.ts';

interface Props {
  overview: LayoverOverview;
  nowMs: number;
  /** Only an ACTIVE session can be aborted — the server rejects the rest. */
  canAbort: boolean;
  /** Called after any abort that reached the server, so the screen can reload. */
  onAborted?: () => void;
}

const TONE_COLOR: Record<PostureTone, string> = {
  calm: color.success,
  warn: color.warn,
  urgent: color.signalDim,
  critical: color.signal,
};

interface AbortState {
  outcome: ReturnNowOutcome;
  /** The contract, wherever it came from — success body or failure body. */
  contract: ReturnContract | null;
  posture: SafeReturnPosture | null;
}

export function LayoverSafeReturnCard({ overview, nowMs, canAbort, onAborted }: Props) {
  const [busy, setBusy] = useState(false);
  const [abort, setAbort] = useState<AbortState | null>(null);
  // A second press while the first is in flight must not fire a second POST.
  // State alone is not enough: two taps inside one frame both read `busy=false`
  // before React commits. The ref is written synchronously, so it is.
  const inFlight = useRef(false);

  const tz = overview.airport.timezone ?? overview.localTimes.timezone;
  const posture = abort?.posture ?? overview.safeReturn;
  const headline = postureHeadline(posture);
  const tone = TONE_COLOR[headline.tone];

  const deadline = describeDeadline(
    overview.offlineBundle,
    overview.window.hardReturnTime,
    nowMs,
  );
  const cert = summarizeCertification(overview.certification);

  const handleReturnNow = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const outcome = await returnToAirportNow(overview.session.id);
      const contract =
        outcome.kind === 'ok' ? outcome.result.returnContract
        : outcome.kind === 'partial' ? outcome.returnContract
        : null;
      const nextPosture =
        outcome.kind === 'ok' ? outcome.result.posture
        : outcome.kind === 'partial' ? outcome.posture
        : null;
      setAbort({ outcome, contract, posture: nextPosture });
      // 'ok' and 'partial' both changed server state (stops cancelled, status,
      // ledger). 'already_ended' means the screen is holding a stale session.
      if (outcome.kind === 'ok' || outcome.kind === 'partial' || outcome.kind === 'already_ended') {
        onAborted?.();
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [overview.session.id, onAborted]);

  const contract = abort?.contract ?? null;
  const outcome = abort?.outcome ?? null;

  return (
    <View style={[styles.card, { borderColor: tone }]} testID="layover-safe-return-card">
      {/* ── Posture ── */}
      <View style={styles.headRow}>
        <Plane size={16} color={tone} />
        <Text style={[styles.state, { color: tone }]} testID="safe-return-state">
          {(posture?.returnState ?? 'NORMAL').replace(/_/g, ' ')}
        </Text>
      </View>
      <Text style={styles.title} testID="safe-return-title">{headline.title}</Text>
      <Text style={styles.body}>{headline.body}</Text>

      {/* ── The deadline, and what we are allowed to claim about it ── */}
      <View style={styles.deadlineBox}>
        <View style={styles.headRow}>
          <Clock size={14} color={color.mute} />
          <Text style={styles.deadlineLabel}>
            {deadline.standing === 'live' ? 'Be back by' : 'Last certified return time'}
          </Text>
        </View>
        <Text style={styles.deadlineTime} testID="safe-return-hard-time">
          {deadline.hardReturnLocal ?? fmtClock(deadline.hardReturnTime, tz)}
        </Text>
        {posture ? (
          <Text style={styles.deadlineSub} testID="safe-return-minutes-left">
            {posture.minutesToHardReturn > 0
              ? `${fmtDur(posture.minutesToHardReturn)} left`
              : `${fmtDur(Math.abs(posture.minutesToHardReturn))} past your return time`}
          </Text>
        ) : null}
        {deadline.stalenessNotice ? (
          <Text style={styles.stale} testID="safe-return-stale-notice">
            {deadline.stalenessNotice}
          </Text>
        ) : null}
      </View>

      {/* ── §15.1 the control ── */}
      {canAbort ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Return to airport now"
          accessibilityState={{ disabled: busy }}
          testID="return-to-airport-btn"
          style={[styles.abortBtn, busy && styles.abortBtnBusy]}
          onPress={handleReturnNow}
          disabled={busy}
        >
          {busy
            ? <ActivityIndicator size="small" color={color.onInk} />
            : <Text style={styles.abortBtnText}>{headline.actionLabel.toUpperCase()}</Text>}
        </Pressable>
      ) : (
        <Text style={styles.inactiveNote} testID="safe-return-inactive">
          This layover is {overview.session.status} — there is nothing left to cancel.
        </Text>
      )}

      {/* ── Outcome ── */}
      {outcome?.kind === 'partial' ? (
        <View style={[styles.notice, styles.noticeBad]} testID="abort-partial-notice">
          <AlertTriangle size={14} color={color.signal} />
          <Text style={styles.noticeText}>{outcome.message}</Text>
        </View>
      ) : null}
      {outcome?.kind === 'already_ended' ? (
        <View style={styles.notice} testID="abort-already-ended">
          <AlertTriangle size={14} color={color.warn} />
          <Text style={styles.noticeText}>{outcome.message}</Text>
        </View>
      ) : null}
      {outcome?.kind === 'offline' ? (
        <View style={styles.notice} testID="abort-offline">
          <WifiOff size={14} color={color.warn} />
          <Text style={styles.noticeText}>
            Couldn't reach the server. The return time above is the last one certified — head back on it.
          </Text>
        </View>
      ) : null}
      {outcome?.kind === 'error' ? (
        <View style={styles.notice} testID="abort-error">
          <AlertTriangle size={14} color={color.warn} />
          <Text style={styles.noticeText}>{outcome.message}</Text>
        </View>
      ) : null}

      {/* The contract renders identically on the success and the partial path. */}
      {contract ? (
        <View style={styles.contract} testID="return-contract">
          {outcome?.kind === 'ok' ? (
            <View style={styles.headRow}>
              <CheckCircle2 size={14} color={color.success} />
              <Text style={[styles.contractHead, { color: color.success }]}>Returning to {contract.airport.iataCode}</Text>
            </View>
          ) : (
            <Text style={[styles.contractHead, { color: color.signal }]}>
              Head to {contract.airport.iataCode} now
            </Text>
          )}
          <Text style={styles.contractTime} testID="contract-hard-time">
            Be back by {fmtClock(contract.hardReturnTime, contract.airport.timezone)}
            {'  ·  '}
            {contract.minutesToHardReturn > 0
              ? `${fmtDur(contract.minutesToHardReturn)} left`
              : `${fmtDur(Math.abs(contract.minutesToHardReturn))} past`}
          </Text>
          <Text style={styles.contractSub}>
            Includes a {contract.bufferMinutes} min return buffer.
          </Text>
          {/* No routing provider exists — say so rather than showing nothing. */}
          <Text style={styles.contractSub} testID="contract-route-unavailable">
            No route guidance available here — use your own maps app.
          </Text>
          {outcome?.kind === 'ok' && outcome.result.cancelledStopIds.length > 0 ? (
            <Text style={styles.contractSub} testID="contract-cancelled-count">
              {outcome.result.cancelledStopIds.length} landside stop
              {outcome.result.cancelledStopIds.length === 1 ? '' : 's'} cancelled.
            </Text>
          ) : null}
          {outcome?.kind === 'ok'
            ? (statusCapabilityNote(outcome.result.statusCapability, outcome.result.statusApplied)
                ? <Text style={styles.contractSub}>
                    {statusCapabilityNote(outcome.result.statusCapability, outcome.result.statusApplied)}
                  </Text>
                : null)
            : null}
          {describeAbortEffects(
            outcome?.kind === 'ok' ? outcome.result.effects
            : outcome?.kind === 'partial' ? outcome.effects
            : [],
          ).map((line) => (
            <Text key={line} style={styles.effectLine} testID="abort-effect-line">{line}</Text>
          ))}
        </View>
      ) : null}

      {/* ── §2.1 when this answer was computed. Not a freshness claim. ── */}
      {cert ? (
        <Text style={styles.cert} testID="safe-return-certification">
          Computed {fmtClock(cert.computedAt, tz)} · {cert.versionLine} · {cert.qualityLine} · inputs {cert.inputHashShort}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card:          { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1.5, padding: space.lg, gap: space.xs },
  headRow:       { flexDirection: 'row', alignItems: 'center', gap: 6 },
  state:         { ...t.stamp, textTransform: 'uppercase' },
  title:         { ...t.heading, color: color.ink, marginTop: 2 },
  body:          { ...t.small, color: color.mute },

  deadlineBox:   { marginTop: space.sm, backgroundColor: color.paper, borderRadius: radius.sm, padding: space.md, gap: 2 },
  deadlineLabel: { ...t.stamp, color: color.mute, textTransform: 'uppercase' },
  deadlineTime:  { ...t.title, color: color.ink },
  deadlineSub:   { ...t.small, color: color.mute },
  stale:         { ...t.small, color: color.warn, fontWeight: '700', marginTop: 4 },

  abortBtn:      { marginTop: space.md, backgroundColor: color.signal, borderRadius: radius.md, paddingVertical: space.md, alignItems: 'center', justifyContent: 'center' },
  abortBtnBusy:  { opacity: 0.6 },
  abortBtnText:  { ...t.bodyStrong, color: color.onInk, letterSpacing: 0.6 },
  inactiveNote:  { ...t.small, color: color.faint, marginTop: space.sm },

  notice:        { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: space.md, backgroundColor: 'rgba(200,133,26,0.10)', borderRadius: radius.sm, padding: space.md },
  noticeBad:     { backgroundColor: 'rgba(255,77,46,0.10)' },
  noticeText:    { ...t.small, color: color.ink, flex: 1, fontWeight: '600' },

  contract:      { marginTop: space.md, borderTopWidth: 1, borderTopColor: color.haze, paddingTop: space.md, gap: 2 },
  contractHead:  { ...t.bodyStrong },
  contractTime:  { ...t.body, color: color.ink, fontWeight: '700' },
  contractSub:   { ...t.small, color: color.mute },
  effectLine:    { ...t.small, color: color.signalDim, fontWeight: '600' },

  cert:          { ...t.stamp, color: color.faint, marginTop: space.md, lineHeight: 15 },
});
