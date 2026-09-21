/**
 * LayoverFlightChangeCard — "my flight moved", and what that did to the plan.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 * The server has a full §11.1 replanner (normalise → impacted sessions →
 * affected constraint nodes → diff the action universe → invalidate → emit an
 * opportunity → notify) and until now nothing could reach it: there is no
 * flight feed and no airport feed on this tree. There is, however, a producer
 * that has always existed — the traveller. A person whose gate agent has just
 * announced a ninety-minute delay knows a fact no feed here carries.
 *
 * This card is that producer. It PATCHes the session window and renders what
 * the replanner decided, which is strictly more than the numbers moving: which
 * planned stops stopped fitting, whether the verdict or return state changed,
 * and whether the change is one the traveller should act on at all.
 *
 * ── WHAT IT WILL NOT DO ──────────────────────────────────────────────────────
 * It moves departure and boarding TOGETHER, by the same minutes, because that
 * is what an airline delay does and because `flight.departure_delayed` is
 * defined to shift them together. An edit that moves them apart is refused by
 * the server with `boarding_moved_independently` rather than replanned wrongly,
 * and the refusal is shown here instead of being swallowed.
 *
 * A refusal is NOT an error. Most refusals are `window_unchanged`, which is the
 * correct answer to pressing a button that changes nothing.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { PlaneTakeoff } from 'lucide-react-native';
import { color, radius, space, type as t } from '../../theme/tokens.ts';
import { updateLayoverSession, type LayoverSession, type ReplanOutcome } from '../../services/layover.ts';

/** Offered shifts, in minutes. Negative = the flight was brought forward. */
const OFFERED_SHIFTS: Array<{ minutes: number; label: string }> = [
  { minutes: -15, label: '15m earlier' },
  { minutes: 15, label: '+15m' },
  { minutes: 30, label: '+30m' },
  { minutes: 60, label: '+1h' },
  { minutes: 120, label: '+2h' },
];

/**
 * The server's refusal reasons, in the traveller's language.
 *
 * Every reason the server can send has an entry. An unmapped reason falls back
 * to the server's own `detail`, which is written to be readable — a silent
 * "nothing happened" would be the one outcome this card must never produce.
 */
const REFUSAL_TEXT: Record<string, string> = {
  window_unchanged: 'That would leave your times exactly as they are.',
  non_window_fields_changed: 'Only a time change can be replanned right now.',
  both_ends_moved: 'Arrival and departure moved together — replan one at a time.',
  boarding_moved_independently: 'Your boarding time no longer lines up with departure.',
  event_rejected: 'That change could not be read as a flight update.',
  inputs_diverged: 'Your layover was edited elsewhere — pull to refresh.',
  session_not_replannable: 'This layover is closed.',
  airport_unreadable: "Your airport's timings could not be loaded.",
  plan_unreadable: 'Your plan could not be read, so nothing was replanned.',
  not_published: 'This server does not report replans yet.',
};

interface Props {
  session: LayoverSession;
  canEdit: boolean;
  /** Called after a successful PATCH so the dashboard re-certifies everything. */
  onChanged: () => void;
  onError: (message: string) => void;
}

function shiftIso(iso: string | null, minutes: number): string | null {
  if (iso === null) return null;
  const t0 = Date.parse(iso);
  if (!Number.isFinite(t0)) return null;
  return new Date(t0 + minutes * 60_000).toISOString();
}

/**
 * The lines a traveller reads. Derived from the server's diff rather than
 * written per press: the client must not invent a consequence the certified
 * recomputation did not produce.
 */
export function replanLines(replan: Extract<ReplanOutcome, { ran: true }>): string[] {
  const lines: string[] = [];
  const d = replan.diff;
  if (d.deadlineDeltaMinutes !== 0) {
    lines.push(
      d.deadlineDeltaMinutes > 0
        ? `You have ${d.deadlineDeltaMinutes} more minutes before you must head back.`
        : `You must head back ${Math.abs(d.deadlineDeltaMinutes)} minutes earlier.`,
    );
  }
  if (d.usableMinutesDelta !== 0) {
    lines.push(
      d.usableMinutesDelta > 0
        ? `Usable time went up by ${d.usableMinutesDelta} min.`
        : `Usable time went down by ${Math.abs(d.usableMinutesDelta)} min.`,
    );
  }
  if (d.candidatesLost.length > 0) {
    lines.push(`${d.candidatesLost.length} planned stop(s) no longer fit your window.`);
  }
  if (d.candidatesGained.length > 0) {
    lines.push(`${d.candidatesGained.length} planned stop(s) fit again.`);
  }
  if (d.verdictChanged) lines.push('The can-I-leave answer changed.');
  if (d.returnStateChanged) lines.push('Your return state changed.');
  if (d.tierChanged) lines.push('Your layover tier changed.');
  if (lines.length === 0) lines.push('Nothing you can act on moved.');
  return lines;
}

export function LayoverFlightChangeCard({ session, canEdit, onChanged, onError }: Props) {
  const [busy, setBusy] = useState<number | null>(null);
  const [replan, setReplan] = useState<ReplanOutcome | null>(null);

  const apply = useCallback(async (minutes: number) => {
    if (busy !== null) return;
    const departureTime = shiftIso(session.departureTime, minutes);
    if (!departureTime) { onError('Your departure time could not be read.'); return; }
    const boardingTime = shiftIso(session.boardingTime, minutes);
    setBusy(minutes);
    try {
      const res = await updateLayoverSession(session.id, {
        departureTime,
        ...(boardingTime ? { boardingTime } : {}),
      });
      setReplan(res.replan);
      onChanged();
    } catch {
      onError('That change could not be saved. Please try again.');
    } finally {
      setBusy(null);
    }
  }, [busy, onError, onChanged, session.boardingTime, session.departureTime, session.id]);

  const lines = useMemo(
    () => (replan && replan.ran ? replanLines(replan) : []),
    [replan],
  );

  if (!canEdit) return null;

  return (
    <View style={styles.card} testID="layover-flight-change-card">
      <View style={styles.head}>
        <PlaneTakeoff size={16} color={color.deep} />
        <Text style={styles.title}>Flight time changed?</Text>
      </View>
      <Text style={styles.sub}>
        Tell us and we'll recompute your window, your deadline and your plan.
      </Text>

      <View style={styles.row}>
        {OFFERED_SHIFTS.map((s) => (
          <Pressable
            key={s.minutes}
            accessibilityRole="button"
            testID={`flight-shift-${s.minutes}`}
            style={[styles.chip, busy !== null && styles.chipDim]}
            disabled={busy !== null}
            onPress={() => apply(s.minutes)}
          >
            {busy === s.minutes
              ? <ActivityIndicator size="small" color={color.ink} />
              : <Text style={styles.chipText}>{s.label}</Text>}
          </Pressable>
        ))}
      </View>

      {replan && !replan.ran ? (
        <Text style={styles.refusal} testID="replan-refusal">
          {REFUSAL_TEXT[replan.reason] ?? replan.detail}
        </Text>
      ) : null}

      {replan && replan.ran ? (
        <View
          style={[styles.outcome, replan.notify.notify && replan.notify.priority === 'high' && styles.outcomeHigh]}
          testID="replan-outcome"
        >
          {replan.notify.notify ? (
            <Text
              style={replan.notify.priority === 'high' ? styles.actHigh : styles.actNormal}
              testID="replan-notify"
            >
              {replan.notify.priority === 'high' ? 'Check your plan — ' : 'Worth knowing — '}
              {replan.notify.reason}
            </Text>
          ) : (
            <Text style={styles.noAct} testID="replan-no-notify">
              Nothing you need to do differently.
            </Text>
          )}
          {lines.map((line) => (
            <Text key={line} style={styles.line}>{line}</Text>
          ))}
          {replan.reasonCodes.includes('RECOMMENDATION_EXPIRED') ? (
            <Text style={styles.expired} testID="replan-recommendation-expired">
              Some saved options were certified against your old window.
            </Text>
          ) : null}
          <Text style={styles.cert} testID="replan-certification">
            {replan.event.eventType} · {replan.certification.engineVersion} · replan {replan.replannerVersion}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card:        { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.sm },
  head:        { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title:       { ...t.bodyStrong, color: color.ink, flex: 1 },
  sub:         { ...t.small, color: color.mute },
  row:         { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip:        { borderWidth: 1, borderColor: color.haze, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: space.sm, minWidth: 64, alignItems: 'center' },
  chipDim:     { opacity: 0.4 },
  chipText:    { ...t.small, color: color.ink, fontWeight: '600' },
  refusal:     { ...t.small, color: color.mute },
  outcome:     { backgroundColor: color.paper, borderRadius: radius.sm, padding: space.md, gap: 4 },
  outcomeHigh: { borderWidth: 1, borderColor: color.signal },
  actHigh:     { ...t.small, color: color.signalDim, fontWeight: '700' },
  actNormal:   { ...t.small, color: color.deep, fontWeight: '700' },
  noAct:       { ...t.small, color: color.mute, fontWeight: '600' },
  line:        { ...t.body, color: color.ink },
  expired:     { ...t.small, color: color.warn, fontWeight: '600' },
  cert:        { ...t.stamp, color: color.faint, marginTop: 4 },
});
