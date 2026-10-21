/**
 * LayoverDisruptionCard — "my flight is delayed / cancelled", reported from the
 * layover screen (census-layover L148, L149, L231).
 *
 * ── SPEC §15.2 "DISRUPTION MODE" ─────────────────────────────────────────────
 *     CONNECTION → DELAYED → SEVERE_DELAY → OVERNIGHT
 *                ↘ CANCELLED → REBOOKING / RECOVERY
 *     "Disruption may expand or shrink the FreedomWindow. Recompute; do not
 *      simply append delay minutes."
 *
 * The machine, the ledger and the recompute all live on the server
 * (`POST /api/airport/sessions/:id/disruption`). This card is the traveller's
 * way in, and it renders what the server answered:
 *
 *   STATE         the state the server moved the session to, and the state its
 *                 ledger held before — never one this card worked out.
 *   RECOMPUTE     the server's before/after (usable minutes, hard return,
 *                 return state) and its `recomputedNotAppended`, for a report
 *                 that moved the departure.
 *   RECOVERY      §21.1 "Flight cancellation → Transition to
 *                 disruption/recovery": the posture the server publishes, said
 *                 as it is. Rebooking, airline contact and airport help each
 *                 read "unavailable" with the server's reason, because none of
 *                 them exists on this tree (census L145). Nothing here offers
 *                 help that is not there.
 *
 * ── THE CLIENT COMPUTES NO TRANSITION ────────────────────────────────────────
 * Which buttons are offered depends on the state the server last answered (a
 * cancelled flight is offered the rebooking reports, not a delay). That is an
 * AFFORDANCE. The state shown after any press is only ever the server's, and
 * a state this build has no label for is shown as its own code.
 *
 * ── THE SOURCE IS THE TRAVELLER ──────────────────────────────────────────────
 * There is no flight feed. The card says so beside every answer, from the
 * server's own `source` field.
 *
 * After every answer that carries a transition, `onReported` fires so the
 * screen re-reads the overview: every other surface then shows the new
 * certification rather than the one this report replaced (L149).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { AlertTriangle } from 'lucide-react-native';
import { color, radius, space, type as t } from '../../theme/tokens.ts';
import { fmtClock, fmtDur } from './layoverFormat.ts';
import {
  readRememberedDisruption,
  rememberDisruption,
  reportLayoverDisruption,
  type DisruptionAnswer,
  type DisruptionKind,
  type DisruptionReport,
  type RecoveryHelp,
} from '../../services/layoverDisruption.ts'; import { chooseDisruptionView, ledgerRecordedAt, overviewDisruptionOf, serverUnknownSentence, type KnownLedgerDisruption } from './layoverDisruptionView.ts';

/** §15.2's states, in a traveller's words. Anything else is shown as its own code. */
const STATE_LABEL: Record<string, string> = {
  CONNECTION: 'On schedule',
  DELAYED: 'Delayed',
  SEVERE_DELAY: 'Severely delayed',
  OVERNIGHT: 'Delayed overnight',
  CANCELLED: 'Cancelled',
  REBOOKING: 'Rebooking offered',
  RECOVERY: 'Rebooked',
};

export function disruptionStateLabel(state: string): string {
  return STATE_LABEL[state] ?? state;
}

/**
 * The reports offered, by the state the SERVER last answered. An affordance:
 * nothing here predicts what the server will answer to a press.
 */
export type OfferedReports = 'flight' | 'rebooking' | 'none';

export function offeredReports(state: string | null): OfferedReports {
  if (state === 'CANCELLED' || state === 'REBOOKING') return 'rebooking';
  if (state === 'RECOVERY') return 'none';
  return 'flight';
}

/** The server's reasons a kind of help is absent, in a traveller's words. */
const HELP_REASON: Record<string, string> = {
  no_airline_integration: 'Portava has no connection to any airline, so it cannot rebook you',
  no_airline_directory: 'Portava has no airline contact directory',
  no_airport_help_directory: 'Portava has no directory of airport help desks',
};

const HELP_ROWS: Array<{ key: 'rebooking' | 'airlineContact' | 'airportHelp'; label: string }> = [
  { key: 'rebooking', label: 'Rebooking' },
  { key: 'airlineContact', label: 'Airline contact' },
  { key: 'airportHelp', label: 'Airport help desk' },
];

function helpSentence(label: string, help: RecoveryHelp): string {
  if (help.available) {
    // Never on this tree. A future server that lists help this build cannot
    // render must not be shown as help either.
    return `${label}: listed as available, but this version of the app cannot show it.`;
  }
  const why = help.reason ? (HELP_REASON[help.reason] ?? help.reason) : 'no reason was given';
  return `${label}: unavailable — ${why}.`;
}

/** A server-supplied minute count with its sign. Formatting, not arithmetic. */
function signedMin(n: number): string {
  if (n > 0) return `+${n} min`;
  if (n < 0) return `−${Math.abs(n)} min`;
  return '0 min';
}

const LOCAL_WALL_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/;
const MAX_DELAY_MINUTES = 72 * 60;

interface Props {
  sessionId: string;
  /** The route accepts reports for a live session only. */
  canReport: boolean;
  /** The airport's timezone, for the clock times the card prints. */
  timezone: string | null;
  /** `YYYY-MM-DD HH:MM`, airport-local, from the server's own local times. Pre-fills the new-departure field. */
  departureLocal?: string | null;
  /** Fired after an answer that carries a transition, so the screen re-reads the overview. */
  onReported: () => void; /** census-layover L148 (round 2): the overview's `disruption` member AS SENT — the server's own memory of this flight, from any device. Preferred over this phone's copy, which is shown only when this is unknown or absent (`layoverDisruptionView.ts`). */ serverDisruption?: unknown;
}

export function LayoverDisruptionCard({ sessionId, canReport, timezone, departureLocal, onReported, serverDisruption }: Props) {
  const [held, setAnswer] = useState<DisruptionAnswer | null>(null);
  /** Set when the answer on screen came from this phone's memory, not from a press. */
  const [rememberedAt, setRememberedAt] = useState<string | null>(null);
  const [notRecorded, setNotRecorded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null); const [heldAgainst, setHeldAgainst] = useState<string | null>(null);
  const [busy, setBusy] = useState<DisruptionKind | null>(null);
  const [delayOpen, setDelayOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [minutesText, setMinutesText] = useState('');
  const [departureText, setDepartureText] = useState(departureLocal ?? '');
  const mounted = useRef(true);
  const pressed = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // A reload shows the last answer the server said it RECORDED, captioned as
  // this phone's copy. A press made before the read lands wins.
  useEffect(() => {
    let live = true;
    void readRememberedDisruption(sessionId).then((rec) => {
      if (!live || !mounted.current || !rec || pressed.current) return;
      setAnswer(rec.answer);
      setRememberedAt(rec.reportedAt);
    });
    return () => { live = false; };
  }, [sessionId]);

  const send = useCallback(async (report: DisruptionReport) => {
    if (busy !== null) return;
    pressed.current = true; setHeldAgainst(ledgerRecordedAt(overviewDisruptionOf(serverDisruption)));
    setBusy(report.kind);
    setError(null);
    try {
      const out = await reportLayoverDisruption(sessionId, report);
      if (!mounted.current) return;
      if (out.ok) {
        setAnswer(out.answer);
        setRememberedAt(null);
        setNotRecorded(null);
        setDelayOpen(false);
        setConfirmCancel(false);
        await rememberDisruption(sessionId, out.answer);
        onReported();
      } else if (out.reason === 'not_recorded') {
        // Applied and not remembered: shown, said, and the screen still
        // re-reads, because the schedule may have moved.
        setAnswer(out.answer);
        setRememberedAt(null);
        setNotRecorded(out.message);
        setDelayOpen(false);
        setConfirmCancel(false);
        onReported();
      } else {
        setError(out.message);
      }
    } finally {
      if (mounted.current) setBusy(null);
    }
  }, [busy, onReported, sessionId, serverDisruption]);

  const sendMinutes = useCallback(() => {
    const raw = minutesText.trim();
    const n = /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n > MAX_DELAY_MINUTES) {
      setError(`Enter the total delay in whole minutes, from 0 to ${MAX_DELAY_MINUTES}.`);
      return;
    }
    void send({ kind: 'delay', delayMinutes: n });
  }, [minutesText, send]);

  const sendDeparture = useCallback(() => {
    const raw = departureText.trim();
    if (!LOCAL_WALL_TIME.test(raw)) {
      setError('Enter the new departure as YYYY-MM-DD HH:MM, in airport time.');
      return;
    }
    void send({ kind: 'delay', newDepartureLocal: raw });
  }, [departureText, send]);

  const server = overviewDisruptionOf(serverDisruption); const view = chooseDisruptionView(server, held, held ? (rememberedAt ? 'phone' : 'press') : null, heldAgainst); const answer = view.from === 'press' || view.from === 'phone' ? view.answer : null; if (!canReport && !answer && view.from !== 'server' && !view.serverUnknown) return null;

  const offered = offeredReports(view.from === 'server' ? view.member.state : answer?.state ?? null);
  const rc = answer?.recompute ?? null; const recovery = answer?.recovery ?? (view.from === 'server' ? view.member.recovery : null);

  return (
    <View style={styles.card} testID="layover-disruption-card">
      <View style={styles.head}>
        <AlertTriangle size={16} color={color.ink} />
        <Text style={styles.title}>Flight delayed or cancelled?</Text>
      </View>
      <Text style={styles.sub}>
        Tell us what the airline announced. Portava has no flight feed, so your report is the source, and your
        layover is recomputed from it.
      </Text>

      {answer ? (
        <View style={styles.status} testID="layover-disruption-status">
          <Text style={styles.label}>YOUR FLIGHT</Text>
          <Text style={styles.state} testID={`layover-disruption-state-${answer.state}`}>
            {disruptionStateLabel(answer.state)}
          </Text>
          <Text style={styles.line} testID="layover-disruption-previous">
            Before this report: {disruptionStateLabel(answer.previousState)}
            {answer.previousStateSource === 'default' ? ' — nothing had been reported' : ''}
          </Text>
          {answer.event.kind === 'delay' && answer.event.delayMinutes != null ? (
            <Text style={styles.line} testID="layover-disruption-total-delay">
              Total delay counted from your original departure: {fmtDur(answer.event.delayMinutes)}
            </Text>
          ) : null}
          <Text style={styles.line} testID="layover-disruption-source">
            {answer.source === 'traveller'
              ? 'Source: your report. Portava has no flight feed.'
              : `Source: ${answer.source}.`}
          </Text>
          {view.from === 'phone' ? (
            <><Text style={styles.line} testID="layover-disruption-remembered">
              Your last report, saved on this phone at {fmtClock(rememberedAt, timezone)}.
            </Text>{view.serverUnknown ? <Text style={styles.line} testID="layover-disruption-server-unknown">{serverUnknownSentence(server)}</Text> : null}</>
          ) : null}
          {notRecorded ? (
            <View style={styles.caution} testID="layover-disruption-not-recorded">
              <Text style={styles.cautionText}>{notRecorded}</Text>
            </View>
          ) : null}
        </View>
      ) : view.from === 'server' ? <ServerDisruptionStatus member={view.member} timezone={timezone} /> : view.serverUnknown ? <Text style={styles.line} testID="layover-disruption-server-unknown">{serverUnknownSentence(server)}</Text> : null}

      {/* L149 — the server's recompute, both sides. Nothing here subtracts. */}
      {rc ? (
        <View style={styles.status} testID="layover-disruption-recompute">
          <Text style={styles.label}>RECOMPUTED FROM YOUR NEW DEPARTURE</Text>
          <Text style={styles.line} testID="layover-disruption-usable">
            Usable time: {fmtDur(rc.before.usableMinutes)} → {fmtDur(rc.after.usableMinutes)} ({signedMin(rc.usableMinutesDelta)})
          </Text>
          <Text style={styles.line} testID="layover-disruption-hard-return">
            Be back at the airport by: {fmtClock(rc.before.hardReturnTime, timezone)} → {rc.after.hardReturnLocal ?? fmtClock(rc.after.hardReturnTime, timezone)}
          </Text>
          <Text style={styles.line} testID="layover-disruption-return-state">
            Return state: {rc.before.returnState} → {rc.after.returnState}
          </Text>
          <Text
            style={styles.line}
            testID={rc.recomputedNotAppended ? 'layover-disruption-recomputed-not-appended' : 'layover-disruption-recomputed-same'}
          >
            {rc.recomputedNotAppended
              ? `Your flight moved ${signedMin(rc.scheduleDeltaMinutes)}; your usable time moved ${signedMin(rc.usableMinutesDelta)}. It was recomputed, not added on.`
              : `Your flight moved ${signedMin(rc.scheduleDeltaMinutes)} and the recomputed usable time moved by the same amount.`}
          </Text>
        </View>
      ) : answer && answer.event.kind === 'delay' && !rememberedAt ? (
        <Text style={styles.line} testID="layover-disruption-no-recompute">
          Your window was not recomputed: only a new departure time moves it. Send the new time below to recompute it.
        </Text>
      ) : null}

      {/* L231 — the recovery posture, as the server states it. */}
      {recovery?.recoveryNeeded ? (
        <View style={styles.status} testID="layover-disruption-recovery">
          <Text style={styles.label}>HELP WITH RECOVERY</Text>
          {HELP_ROWS.map((row) => (
            <Text key={row.key} style={styles.line} testID={`layover-disruption-help-${row.key}`}>
              {helpSentence(row.label, recovery[row.key])}
            </Text>
          ))}
          <Text style={styles.line}>Rebooking happens with your airline, not in Portava.</Text>
        </View>
      ) : answer && !answer.recovery && offered === 'rebooking' ? (
        <Text style={styles.line} testID="layover-disruption-recovery-unstated">
          Portava did not say what recovery help exists, so none is shown.
        </Text>
      ) : null}

      {canReport && offered === 'rebooking' ? (
        <View style={styles.controls} testID="layover-disruption-next">
          <Text style={styles.line}>Next: tell us what the airline does.</Text>
          <View style={styles.row}>
            <ReportButton testID="layover-disruption-report-rebooking_offered" label="The airline offered a new flight" busy={busy === 'rebooking_offered'} disabled={busy !== null} onPress={() => void send({ kind: 'rebooking_offered' })} />
            <ReportButton testID="layover-disruption-report-rebooking_confirmed" label="My new flight is confirmed" busy={busy === 'rebooking_confirmed'} disabled={busy !== null} onPress={() => void send({ kind: 'rebooking_confirmed' })} />
          </View>
        </View>
      ) : null}

      {canReport && offered === 'flight' ? (
        <View style={styles.controls} testID="layover-disruption-controls">
          <View style={styles.row}>
            <ReportButton testID="layover-disruption-open-delay" label="Delayed" busy={false} disabled={busy !== null} onPress={() => { setConfirmCancel(false); setDelayOpen((v) => !v); }} />
            <ReportButton testID="layover-disruption-report-cancellation" label="Cancelled" busy={busy === 'cancellation'} disabled={busy !== null} onPress={() => { setDelayOpen(false); setConfirmCancel(true); }} />
            <ReportButton testID="layover-disruption-report-on_time" label="Back on time" busy={busy === 'on_time'} disabled={busy !== null} onPress={() => void send({ kind: 'on_time' })} />
          </View>

          {confirmCancel ? (
            <View style={styles.status} testID="layover-disruption-confirm">
              <Text style={styles.line}>
                Report this flight as cancelled? Portava keeps a cancellation: a later delay or on-time report will not undo it.
              </Text>
              <View style={styles.row}>
                <ReportButton testID="layover-disruption-confirm-cancellation" label="Yes, it's cancelled" primary busy={busy === 'cancellation'} disabled={busy !== null} onPress={() => void send({ kind: 'cancellation' })} />
                <ReportButton testID="layover-disruption-confirm-back" label="Back" busy={false} disabled={busy !== null} onPress={() => setConfirmCancel(false)} />
              </View>
            </View>
          ) : null}

          {delayOpen ? (
            <View style={styles.status} testID="layover-disruption-delay-form">
              <Text style={styles.line}>The new departure time, in airport time — this recomputes your window:</Text>
              <View style={styles.inputRow}>
                <TextInput
                  testID="layover-disruption-new-departure"
                  accessibilityLabel="New departure, airport time, as year-month-day hours:minutes"
                  style={styles.input}
                  value={departureText}
                  onChangeText={setDepartureText}
                  placeholder="YYYY-MM-DD HH:MM"
                  placeholderTextColor={color.mute}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <ReportButton testID="layover-disruption-send-new-departure" label="Send" primary busy={busy === 'delay'} disabled={busy !== null} onPress={sendDeparture} />
              </View>
              <Text style={styles.line}>Or only the total delay in minutes, if there is no new time yet:</Text>
              <View style={styles.inputRow}>
                <TextInput
                  testID="layover-disruption-delay-minutes"
                  accessibilityLabel="Total delay in minutes"
                  style={styles.input}
                  value={minutesText}
                  onChangeText={setMinutesText}
                  placeholder="e.g. 90"
                  placeholderTextColor={color.mute}
                  keyboardType="number-pad"
                />
                <ReportButton testID="layover-disruption-send-delay-minutes" label="Send" busy={false} disabled={busy !== null} onPress={sendMinutes} />
              </View>
            </View>
          ) : null}
        </View>
      ) : null}

      {canReport && offered === 'none' ? (
        <Text style={styles.line} testID="layover-disruption-nothing-next">
          Your rebooking is confirmed. There is nothing more to report here.
        </Text>
      ) : null}

      {error && !notRecorded ? (
        <View style={styles.caution} testID="layover-disruption-error">
          <Text style={styles.cautionText}>{error}</Text>
        </View>
      ) : null}
    </View>
  );
}

function ReportButton({ testID, label, busy, disabled, onPress, primary = false }: {
  testID: string; label: string; busy: boolean; disabled: boolean; onPress: () => void; primary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy }}
      testID={testID}
      style={[styles.btn, primary && styles.btnPrimary, disabled && !busy && styles.btnDim]}
      disabled={disabled}
      onPress={onPress}
    >
      {busy
        ? <ActivityIndicator size="small" color={primary ? color.onInk : color.ink} />
        : <Text style={[styles.btnText, primary && styles.btnTextPrimary]}>{label}</Text>}
    </Pressable>
  );
}

// WCAG AA: every text colour here is `ink` or `mute` on `paperRaised`/`paper`
// (≥ 5.3:1), `onInk` on `ink`, or `ink` on a light warn tint over white. No
// `faint`, `warn`, `signal` or §33 strong token is used as a text colour.
const styles = StyleSheet.create({
  card:        { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.sm },
  head:        { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title:       { ...t.bodyStrong, color: color.ink, flex: 1 },
  sub:         { ...t.small, color: color.mute },
  status:      { backgroundColor: color.paper, borderRadius: radius.sm, padding: space.md, gap: 4 },
  label:       { ...t.stamp, color: color.mute },
  state:       { ...t.heading, color: color.ink },
  line:        { ...t.small, color: color.ink },
  caution:     { backgroundColor: 'rgba(200,133,26,0.12)', borderRadius: radius.sm, padding: space.sm },
  cautionText: { ...t.small, color: color.ink, fontWeight: '600' },
  controls:    { gap: space.sm },
  row:         { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  inputRow:    { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  input:       { ...t.small, flex: 1, color: color.ink, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: space.sm },
  btn:         { borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: space.sm, minWidth: 64, alignItems: 'center' },
  btnPrimary:  { backgroundColor: color.ink, borderColor: color.ink },
  btnDim:      { opacity: 0.4 },
  btnText:     { ...t.small, color: color.ink, fontWeight: '600' },
  btnTextPrimary: { color: color.onInk },
});

/**
 * census-layover L148 (round 2) — the SERVER's memory of this flight, from the
 * overview's `disruption` member. Shown on a reload (or after another device
 * reported), in place of this phone's copy. Everything on it is the server's:
 * the state from its ledger, the time it recorded it, who reported it.
 * Text colours as above: `ink` / `mute` on `paper` (measured ≥ 5.27:1).
 */
function ServerDisruptionStatus({ member, timezone }: { member: KnownLedgerDisruption; timezone: string | null }) {
  return (
    <View style={styles.status} testID="layover-disruption-server-status">
      <Text style={styles.label}>YOUR FLIGHT</Text>
      <Text style={styles.state} testID={`layover-disruption-state-${member.state}`}>
        {disruptionStateLabel(member.state)}
      </Text>
      <Text style={styles.line} testID="layover-disruption-server-recorded">
        {member.recordedAt
          ? `Your last report, as Portava recorded it at ${fmtClock(member.recordedAt, timezone)} — from this phone or any other.`
          : 'Your last report, as Portava recorded it — from this phone or any other.'}
      </Text>
      <Text style={styles.line} testID="layover-disruption-source">
        {member.reportedBy === 'traveller'
          ? 'Source: your report. Portava has no flight feed.'
          : `Source: ${member.reportedBy ?? 'not stated'}.`}
      </Text>
    </View>
  );
}
