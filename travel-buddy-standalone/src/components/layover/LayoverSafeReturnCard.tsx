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
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { AlertTriangle, CheckCircle2, Clock, Plane, WifiOff } from 'lucide-react-native';
import { color, radius, space, type as t } from '../../theme/tokens.ts';
import { type LayoverOverview } from '../../services/layover.ts';
import type { SafeReturnAbortController } from './useSafeReturnAbort.ts';
import {
  describeAbortEffects,
  describeCrewMeetingPoint,
  describeCrewNotification,
  describeDeadline,
  postureHeadline,
  statusCapabilityNote,
  summarizeCertification,
  type PostureTone,
} from './layoverReturnFacts.ts';
import { fmtClock, fmtDur } from './layoverFormat.ts'; import { LayoverCheckpointControl, checkpointCapability } from './LayoverCheckpointControl.tsx'; import { LayoverCrewAbortToggle } from './LayoverCrewAbortToggle.tsx'; // census-layover L144; same line, so no cited line moves

interface Props {
  overview: LayoverOverview;
  nowMs: number;
  /** Only an ACTIVE session can be aborted — the server rejects the rest. */
  canAbort: boolean;
  /**
   * The abort, owned by the screen (`useSafeReturnAbort`) so that the footer
   * CTA and the map's airport element can fire the SAME one — census L42 and
   * L123. This card is still the only place the return CONTRACT is rendered,
   * which is what §13.4 said a second control must not cost.
   */
  abort: SafeReturnAbortController;
}

const TONE_COLOR: Record<PostureTone, string> = {
  calm: color.success,
  warn: color.warn,
  urgent: color.signalDim,
  critical: color.signal,
};

export function LayoverSafeReturnCard({ overview, nowMs, canAbort, abort: controller }: Props) {
  const busy = controller.busy;
  const abort = controller.state;
  const handleReturnNow = controller.run;

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
  // §16 L154 — the cached crew meeting point. Always a sentence: available or
  // not, an offline capability says which, because a blank line reads as "fine".
  const crewPoint = describeCrewMeetingPoint(overview.offlineBundle);

  const contract = abort?.contract ?? null;
  const outcome = abort?.outcome ?? null;
  /**
   * §15.1 L144 — what the server says happened to the crew, read off the
   * fields rather than re-derived and rendered only on the path that carries
   * them. A PARTIAL abort's 500 body is not an `AbortResult`; since L144 it carries
   * both fields too (a pre-L144 server's has neither: absence is silence here, never
   * "your crew was not told", which would be this card answering for the
   * server).
   */
  const crewNotice = outcome?.kind === 'ok' || (outcome?.kind === 'partial' && outcome.crewNotifyUnavailableReason !== undefined)
    ? describeCrewNotification({
        crewNotifiedCount: outcome.kind === 'ok' ? (outcome.result.crewNotifiedCount ?? outcome.result.crewNotified?.length ?? 0) : (outcome.crewNotifiedCount ?? 0),
        crewNotifyUnavailableReason: (outcome.kind === 'ok' ? outcome.result.crewNotifyUnavailableReason : outcome.crewNotifyUnavailableReason) ?? null,
      })
    : null;

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
        {/* §16 L154 — inside the deadline box because it shares the deadline's
            standing: both come out of the SAME bundle, so a stale bundle's
            meeting point is last-certified for exactly the reason its deadline
            is, and the caption above governs both. Nothing here re-tests the
            staleness bound. */}
        <Text style={styles.crewPoint} testID="safe-return-crew-meeting-point">
          {crewPoint.sentence}
        </Text>
      </View>

      {/* ── §15.1 the control ── */}{canAbort ? <><LayoverCrewAbortToggle overview={overview} controller={controller} /><LayoverBuddyAbortToggle overview={overview} controller={controller} /></> : null}{/* census-layover L144: the traveller's own per-abort choice, offered only when the server would honour it */}
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

      {/* ── Outcome ── */}{canAbort && controller.runWithOrigin ? <LayoverReturnRouteAction sessionId={overview.session.id} controller={controller} /> : null}{overview.safeReturnProduct ? <LayoverReturnProduct key={overview.session.id} sessionId={overview.session.id} initial={overview.safeReturnProduct} /> : null}
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
          {/* Route responses retain their own server expiry beside the deadline. */}{contract.route ? <LayoverAbortRouteSummary route={contract.route} nowMs={nowMs} /> :
          <Text style={styles.contractSub} testID="contract-route-unavailable">
            No route guidance available here — use your own maps app.
          </Text>}
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
          {/* §15.1 L144 — who was told about this traveller's abort. It is
              reported here; the only control is the traveller's own per-abort
              choice above (LayoverCrewAbortToggle), and whether a crew may be told at all is the owner's flag, not decided
              on the client. See `describeCrewNotification`. */}
          <BuddyAbortNotice outcome={outcome} />{crewNotice ? (
            <Text style={styles.contractSub} testID="abort-crew-notice">{crewNotice}</Text>
          ) : null}
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

      {/* census L30 / L173 — the traveller's own "left / back" reports. Rendered
          only when the overview says 2992's store is on; see LayoverCheckpointControl. */}
      {checkpointCapability(overview) === 'on' ? (
        <LayoverCheckpointControl
          sessionId={overview.session.id}
          canReport={overview.session.status === 'active' || (overview.session.status as string) === 'returning'}
          timezone={tz ?? null}
        />
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
  // Deliberately the muted tone, not the warning one: an uncached meeting point
  // is an honest absence, not a safety signal and not an error.
  crewPoint:     { ...t.small, color: color.mute, marginTop: 4 },

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

// L221: location is requested only by this explicit control, never at mount or by the basic abort action.
import { requestLocationForUserAction, USER_PRESS_LIVE_RETURN } from '../../lib/location/locationRequestDoor.ts';
import type { AbortReturnRoute } from '../../services/layover.ts';

function LayoverReturnRouteAction({ sessionId, controller }: { sessionId: string; controller: SafeReturnAbortController }) {
  const [locating, setLocating] = React.useState(false);
  const generation = React.useRef(0);
  const inFlight = React.useRef(false);
  React.useEffect(() => { setLocating(false); return () => { ++generation.current; inFlight.current = false; }; }, [sessionId]);
  async function returnFromLocation() {
    if (inFlight.current || controller.busy) return;
    inFlight.current = true; setLocating(true); const mine = generation.current;
    try {
      const gps = await requestLocationForUserAction(USER_PRESS_LIVE_RETURN);
      if (mine !== generation.current) return;
      if (gps.granted && typeof gps.lat === 'number' && typeof gps.lng === 'number' && typeof gps.accuracyMeters === 'number' && typeof gps.observedAtMs === 'number' && Number.isFinite(gps.observedAtMs)) {
        controller.runWithOrigin?.({ lat: gps.lat, lng: gps.lng, accuracyMeters: gps.accuracyMeters, observedAt: new Date(gps.observedAtMs).toISOString(), mode: 'drive' });
      } else controller.run();
    } catch { if (mine === generation.current) controller.run(); }
    finally { if (mine === generation.current) { inFlight.current = false; setLocating(false); } }
  }
  return <Pressable testID="return-with-location" onPress={returnFromLocation} accessibilityRole="button" disabled={locating || controller.busy} accessibilityState={{ disabled: locating || controller.busy }}>
    <Text style={styles.contractSub}>{locating ? 'Finding your location…' : 'Return with a driving route from my location'}</Text>
  </Pressable>;
}

function LayoverAbortRouteSummary({ route, nowMs }: { route: AbortReturnRoute; nowMs: number }) {
  const expired = !Number.isFinite(Date.parse(route.expiresAt)) || Date.parse(route.expiresAt) <= nowMs;
  return <View testID="contract-measured-route">
    <Text style={styles.contractSub}>{route.mode === 'walk' ? 'Walk' : 'Drive'}: {route.minutes} min estimated; allow {route.conservativeMinutes} min.</Text>
    {expired ? <Text testID="contract-route-expired" style={styles.stale}>Last route estimate has expired. Check current conditions before relying on it.</Text> : null}
    {!route.canMeetDeadline ? <Text testID="contract-route-late" style={styles.stale}>This route is estimated to reach the airport after your required return time. Head back now and contact the airline.</Text> : null}
    {route.conveyances.map((leg, i) => <Text key={i} style={styles.contractSub}>{i + 1}. {leg.mode}: {leg.minutes} min{leg.endsAt ? ` · ${leg.endsAt}` : ''}</Text>)}
  </View>;
}

import { SafeReturnSetupSheet } from '../safeReturn/SafeReturnSetupSheet.tsx';
import { ActiveSafeReturnCard } from '../safeReturn/ActiveSafeReturnCard.tsx';
import { getLayoverSafeReturnProduct, reportLayoverCheckpoint, type LayoverSafeReturnProductState } from '../../services/layover.ts';
function LayoverReturnProduct({sessionId,initial}:{sessionId:string;initial:LayoverSafeReturnProductState}) {
  const [state,setState]=React.useState(initial), [setup,setSetup]=React.useState(false), [error,setError]=React.useState<string|null>(null);
  const alive=React.useRef(true), arrivalOperation=React.useRef<string|null>(null);
  React.useEffect(() => {setState(initial);},[initial]);
  React.useEffect(() => {alive.current=true;return () => {alive.current=false;};},[]);
  const refresh=async () => {try {const next=await getLayoverSafeReturnProduct(sessionId);if(alive.current){setState(next);setError(null);}} catch {if(alive.current)setError('Safe Return could not be checked. Open it again to retry.');}};
  const arrive=async () => {
    arrivalOperation.current ??= `safe-return-arrival-${Date.now()}`;
    const result=await reportLayoverCheckpoint(sessionId,'AIRPORT_REENTRY',arrivalOperation.current);
    if(!result.ok || result.safeReturn?.ok!==true || result.safeReturn.closed!==true){if(alive.current)setError('Your return timer could not be closed. Please retry the airport check-in.');return {ok:false};}
    await refresh();return {ok:true};
  };
  if(!state.available) return error ? <Text style={styles.stale}>{error}</Text> : null;
  const active=state.session && ['pending','active','missed'].includes(state.session.status);
  return <View testID="layover-safe-return-product">
    {error ? <Text style={styles.stale}>{error}</Text> : null}
    {active && state.session ? <ActiveSafeReturnCard session={state.session} deadlineLocked onConfirmArrival={arrive} onSessionEnded={() => {void refresh();}} onSessionUpdated={(session) => setState(s=>({...s,session}))} /> : state.session ? <Text style={styles.contractSub}>Safe Return has ended.</Text> : <Pressable testID="layover-product-setup" accessibilityRole="button" onPress={() => setSetup(true)}><Text style={styles.contractSub}>Use Safe Return for this trip back</Text></Pressable>}
    <SafeReturnSetupSheet visible={setup} onClose={() => setSetup(false)} onStarted={() => {void refresh();}} layoverSessionId={sessionId} certifiedDeadline={state.certifiedDeadline ?? undefined} suggestionReason="Use your certified airport return deadline. Choose who, if anyone, should be alerted if you miss it." />
  </View>;
}

import { LayoverBuddyAbortToggle, BuddyAbortNotice } from './LayoverBuddyAbortToggle.tsx';
