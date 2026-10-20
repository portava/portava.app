/**
 * LayoverAnswerChangesCard — "what changed since the last answer" (census-layover
 * L190; the Layover spec's north star: Layover must answer "What can this
 * traveler safely do …, what changed since the last answer, and what must they
 * do now?").
 *
 *   L190  `LayoverDecisionService.diff(previousSnapshotId, nextSnapshotId)`
 *         → GET /api/airport/sessions/:id/decisions/diff?from=&to=
 *
 * ── WHAT IT COMPARES ─────────────────────────────────────────────────────────
 * `from` is the answer this traveller last ACKNOWLEDGED on this device
 * (`layoverAnswerMemory`); `to` is the answer on screen. Both must be stored
 * answers: the card runs only when the overview says the ledger stored the one
 * on screen (`persisted.state` recorded / already_recorded), exactly the rule
 * `LayoverDecisionRecordCard` uses. Production stores nothing today
 * (`layover_decision_persistence_enabled` absent), so the card draws nothing and
 * sends nothing there.
 *
 * ── WHAT IT SAYS ─────────────────────────────────────────────────────────────
 * Only what the SERVER says changed (`changes`, plus the reason codes the diff
 * added or cleared), each with its value in both answers. The clock is not a
 * change: the server does not report usable time that only the passing minutes
 * explain, and an empty list draws nothing. Changes accumulate until the
 * traveller taps "Got it"; only then does the remembered answer move. A diff the
 * server could not read is said as such and remembered nothing, so the next
 * load compares against the same acknowledged answer. Nothing here compares two
 * answers itself.
 *
 * Text colours: `ink` / `mute` on `paperRaised` / `paper` only, as the record
 * card beside it.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { History } from 'lucide-react-native';
import { color, radius, space, type as t } from '../../theme/tokens.ts';
import { fmtClock, fmtDur } from './layoverFormat.ts';
import { describeVerdict } from './layoverVerdictFacts.ts';
import { describeReasonCode } from '../../lib/layoverReasonCodes.ts';
import { readAnswerSeen, rememberAnswerSeen } from '../../lib/layoverAnswerMemory.ts';
import { getLayoverAnswerChanges, type LayoverAnswerChange, type LayoverAnswerChangesRead } from '../../services/layover.ts';

const SNAPSHOT_ID = /^snap:[0-9a-f]{32}$/;
const STORED_STATES = new Set(['recorded', 'already_recorded']);

const RETURN_STATE_WORDS: Record<string, string> = {
  NORMAL: 'on track',
  RETURN_SOON: 'head back soon',
  RETURN_NOW: 'head back now',
  CONNECTION_AT_RISK: 'connection at risk',
};

function own<T>(table: Record<string, T>, key: unknown): T | undefined {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** One change, in a traveller's words. Every value printed is the server's. */
export function changeSentence(c: LayoverAnswerChange, timezone: string | null): string {
  switch (c.field) {
    case 'verdict':
      return `Portava's answer changed: ${describeVerdict(c.next).label} (was ${describeVerdict(c.previous).label}).`;
    case 'returnState':
      return `Return status: ${own(RETURN_STATE_WORDS, c.next) ?? String(c.next)} (was ${own(RETURN_STATE_WORDS, c.previous) ?? String(c.previous)}).`;
    case 'hardReturnTime': {
      const moved = typeof c.minutesMoved === 'number' && c.minutesMoved !== 0
        ? ` — ${Math.abs(c.minutesMoved)} min ${c.minutesMoved < 0 ? 'earlier' : 'later'}`
        : '';
      return `Be back at the airport by ${fmtClock(String(c.next), timezone)} (was ${fmtClock(String(c.previous), timezone)})${moved}.`;
    }
    case 'usableMinutes':
      return typeof c.next === 'number' && typeof c.previous === 'number'
        ? `Usable time: ${fmtDur(c.next)} (was ${fmtDur(c.previous)}), more than the time that has passed explains.`
        : `Usable time changed (${String(c.previous)} → ${String(c.next)}).`;
    case 'confidence':
      return `How sure Portava is: ${String(c.next).toLowerCase()} (was ${String(c.previous).toLowerCase()}).`;
    default:
      return `${c.field}: ${String(c.next)} (was ${String(c.previous)}).`;
  }
}

/** The lines the card draws for a server answer, or [] when nothing a traveller acts on moved. */
export function changeLines(read: Extract<LayoverAnswerChangesRead, { ok: true }>, timezone: string | null): string[] {
  return [
    ...read.changes.map((c) => changeSentence(c, timezone)),
    ...read.reasonCodesAdded.map((code) => `New: ${describeReasonCode(code).title}`),
    ...read.reasonCodesRemoved.map((code) => `No longer: ${describeReasonCode(code).title}`),
  ];
}

interface Props {
  sessionId: string;
  /** The overview's `snapshotId`: the answer on screen. */
  snapshotId: string | null | undefined;
  /** The overview's `persisted`: whether the ledger stored that answer. */
  persisted: { state: string; reason?: string } | null | undefined;
  /** The airport's timezone, for the clock times printed. */
  timezone: string | null;
}

type Shown =
  | { kind: 'changes'; to: string; lines: string[] }
  | { kind: 'cannot_check'; message: string }
  | { kind: 'earlier_gone'; to: string }
  | { kind: 'not_stored' };

export function LayoverAnswerChangesCard({ sessionId, snapshotId, persisted, timezone }: Props) {
  const [shown, setShown] = useState<Shown | null>(null);
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const stored = !!persisted && STORED_STATES.has(persisted.state) && typeof snapshotId === 'string' && SNAPSHOT_ID.test(snapshotId);

  useEffect(() => {
    if (!stored || typeof snapshotId !== 'string') return;
    let live = true;
    void (async () => {
      const seen = await readAnswerSeen(sessionId);
      if (!live || !mounted.current) return;
      if (seen === null) {
        // The first stored answer this device has seen for this layover: there is nothing earlier to compare.
        await rememberAnswerSeen(sessionId, snapshotId);
        return;
      }
      if (seen === snapshotId) { setShown(null); return; }
      const read = await getLayoverAnswerChanges(sessionId, seen, snapshotId);
      if (!live || !mounted.current) return;
      if (read.ok) {
        const lines = changeLines(read, timezone);
        if (lines.length === 0) {
          // Nothing a traveller acts on moved: the answer on screen IS the last answer, in substance.
          await rememberAnswerSeen(sessionId, snapshotId);
          if (live && mounted.current) setShown(null);
        } else {
          setShown({ kind: 'changes', to: snapshotId, lines });
        }
        return;
      }
      if (read.kind === 'gone') { setShown({ kind: 'earlier_gone', to: snapshotId }); return; }
      if (read.kind === 'unavailable') { setShown({ kind: 'not_stored' }); return; }
      if (read.kind === 'disabled') { setShown(null); return; }
      setShown({ kind: 'cannot_check', message: read.message });
    })();
    return () => { live = false; };
  }, [stored, sessionId, snapshotId, timezone, attempt]);

  const acknowledge = useCallback(async (to: string) => {
    await rememberAnswerSeen(sessionId, to);
    if (mounted.current) setShown(null);
  }, [sessionId]);

  if (!stored || shown === null) return null;

  if (shown.kind === 'changes' || shown.kind === 'earlier_gone') {
    const to = shown.to;
    return (
      <View style={styles.card} testID="layover-answer-changes-card">
        <View style={styles.head}>
          <History size={16} color={color.ink} />
          <Text style={styles.title}>What changed since your last answer</Text>
        </View>
        {shown.kind === 'changes'
          ? shown.lines.map((line, i) => <Text key={i} style={styles.line} testID={`layover-answer-change-${i}`}>• {line}</Text>)
          : (
            <Text style={styles.mute} testID="layover-answer-changes-earlier-gone">
              Portava no longer keeps the earlier answer, so it cannot say what changed. The answer above is the current one.
            </Text>
          )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Got it"
          testID="layover-answer-changes-ack"
          style={styles.btn}
          onPress={() => void acknowledge(to)}
        >
          <Text style={styles.btnText}>Got it</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.card} testID={`layover-answer-changes-${shown.kind}`}>
      <Text style={styles.mute}>
        {shown.kind === 'not_stored'
          ? "Portava is not keeping its answers right now, so it cannot say what changed since your last one."
          : `Portava could not check what changed since your last answer. ${shown.message}`}
      </Text>
      {shown.kind === 'cannot_check' ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Check again" testID="layover-answer-changes-retry" style={styles.btn} onPress={() => setAttempt((n) => n + 1)}>
          <Text style={styles.btnText}>Check again</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card:    { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.sm },
  head:    { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title:   { ...t.bodyStrong, color: color.ink, flex: 1 },
  line:    { ...t.small, color: color.ink },
  mute:    { ...t.small, color: color.mute },
  btn:     { alignSelf: 'flex-start', borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: space.sm, minWidth: 64, alignItems: 'center' },
  btnText: { ...t.small, color: color.ink, fontWeight: '600' },
});
