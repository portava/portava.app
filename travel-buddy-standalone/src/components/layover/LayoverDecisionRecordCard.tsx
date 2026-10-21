/**
 * LayoverDecisionRecordCard — Portava's stored record of the answer on this
 * screen, explained and re-checked (census-layover L189, L191).
 *
 *   L189  `LayoverDecisionService.explain(snapshotId)`
 *         → GET /api/airport/sessions/:id/decisions/:snapshotId/explain
 *   L191  `LayoverDecisionService.replay(sessionId, engineVersion)`
 *         → GET /api/airport/sessions/:id/decisions/replay?engineVersion=
 *
 * ── WHAT IT EXPLAINS ─────────────────────────────────────────────────────────
 * The overview publishes the snapshot id of the answer it just gave and whether
 * the §20 ledger stored it (`persisted`). "How we got these numbers" on
 * CanILeaveCard explains the LIVE computation; this explains the STORED one, and
 * only after the server re-ran it from its stored facts and got the same answer
 * back (`verifiedBy: "replay_match"`). A stored answer that does not reproduce is
 * said to be one, never explained.
 *
 * ── WHEN IT IS SHOWN ─────────────────────────────────────────────────────────
 * Only when the overview says the answer WAS STORED (`persisted.state` is
 * `recorded` / `already_recorded`) and names its snapshot. Production today
 * stores nothing (`layover_decision_persistence_enabled` absent, 2700/2992
 * unapplied), so the card is not drawn: a card offering to explain a record that
 * does not exist would be the §23.1 mistake on a new surface. If the ledger is
 * switched off between the overview and a tap, the route's NAMED refusal is
 * shown as the sentence it is.
 *
 * Nothing here computes a verdict, a count or a deadline: every figure is the
 * server's. Text colours: `ink` / `mute` on `paperRaised` / `paper` only
 * (measured ≥ 5.27:1, WCAG AA); no `faint`, `warn`, `signal` or §33 strong token.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { FileCheck } from 'lucide-react-native';
import { color, radius, space, type as t } from '../../theme/tokens.ts';
import { fmtClock, fmtDur } from './layoverFormat.ts';
import {
  explainLayoverDecision,
  replayLayoverDecisions,
  type LayoverDecisionExplainRead,
  type LayoverDecisionReplayRead,
} from '../../services/layover.ts';

const SNAPSHOT_ID = /^snap:[0-9a-f]{32}$/;
const STORED_STATES = new Set(['recorded', 'already_recorded']);

/** The route's named refusals, in a traveller's words. Anything else is shown as its code. */
const UNAVAILABLE: Record<string, string> = {
  feature_disabled: 'Portava is not keeping a record of its answers right now, so there is nothing stored to check.',
  flag_unreadable: 'Portava could not tell whether its record is switched on, so nothing was read. Try again in a moment.',
  storage_unavailable: "Portava's record of its answers is not set up on this server, so there is nothing stored to check.",
};

export function unavailableSentence(reason: string): string {
  return UNAVAILABLE[reason] ?? `Portava's record is unavailable (${reason}).`;
}

export function notExplainedSentence(reason: string, detail: string[]): string {
  const fields = detail.length > 0 ? ` (${detail.join(', ')})` : '';
  if (reason === 'replay_mismatch') {
    return `Portava will not explain this stored answer: re-run from the facts it was given, it comes out differently${fields}.`;
  }
  if (reason === 'not_replayable') {
    return `This stored answer was made by different rules, so it cannot be re-run here${fields}.`;
  }
  return `Portava could not explain this stored answer (${reason})${fields}.`;
}

/** The server's replay summary, said as counts the server gave. No arithmetic beyond pluralising. */
export function replaySentences(read: Extract<LayoverDecisionReplayRead, { ok: true }>): string[] {
  const s = read.summary;
  if (s.read === 0) return ['Portava has no stored answers for this layover from the engine that made this one.'];
  const answers = (n: number) => `${n} stored answer${n === 1 ? '' : 's'}`;
  const out = [`Portava re-ran ${answers(s.read)} for this layover: ${s.matched} came out exactly as stored.`];
  if (s.mismatched > 0) out.push(`${s.mismatched} did not — re-run from the facts it was given, it comes out differently.`);
  if (s.refused > 0) out.push(`${s.refused} could not be re-run here (made by different rules).`);
  if (read.truncated) out.push(`Only the newest ${s.read} were checked.`);
  return out;
}

interface Props {
  sessionId: string;
  /** The overview's `snapshotId`: the identity of the answer on screen. */
  snapshotId: string | null | undefined;
  /** The overview's `persisted`: whether the ledger stored that answer. */
  persisted: { state: string; reason?: string } | null | undefined;
  /** The engine that made the answer on screen (`certification.engineVersion`). */
  engineVersion: string | null | undefined;
  /** The airport's timezone, for the clock times printed. */
  timezone: string | null;
}

export function LayoverDecisionRecordCard({ sessionId, snapshotId, persisted, engineVersion, timezone }: Props) {
  const [explained, setExplained] = useState<LayoverDecisionExplainRead | null>(null);
  const [replayed, setReplayed] = useState<LayoverDecisionReplayRead | null>(null);
  const [busy, setBusy] = useState<'explain' | 'replay' | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  // A new answer on screen is a new record: what was said about the old one goes.
  useEffect(() => { setExplained(null); setReplayed(null); }, [snapshotId]);

  const stored = !!persisted && STORED_STATES.has(persisted.state) && typeof snapshotId === 'string' && SNAPSHOT_ID.test(snapshotId);

  const explain = useCallback(async () => {
    if (busy !== null || typeof snapshotId !== 'string') return;
    setBusy('explain');
    try {
      const out = await explainLayoverDecision(sessionId, snapshotId);
      if (mounted.current) setExplained(out);
    } finally {
      if (mounted.current) setBusy(null);
    }
  }, [busy, sessionId, snapshotId]);

  const replay = useCallback(async () => {
    if (busy !== null || !engineVersion) return;
    setBusy('replay');
    try {
      const out = await replayLayoverDecisions(sessionId, engineVersion);
      if (mounted.current) setReplayed(out);
    } finally {
      if (mounted.current) setBusy(null);
    }
  }, [busy, sessionId, engineVersion]);

  if (!stored) return null;

  return (
    <View style={styles.card} testID="layover-decision-record-card">
      <View style={styles.head}>
        <FileCheck size={16} color={color.ink} />
        <Text style={styles.title}>Portava&apos;s record of this answer</Text>
      </View>
      <Text style={styles.sub}>
        Portava stored the answer above when it gave it to you. Have it explained from that record, or re-check every answer
        it stored for this layover.
      </Text>
      <View style={styles.row}>
        <RecordButton testID="layover-decision-explain" label="Explain the stored answer" busy={busy === 'explain'} disabled={busy !== null} onPress={() => void explain()} />
        {engineVersion ? (
          <RecordButton testID="layover-decision-replay" label="Re-check stored answers" busy={busy === 'replay'} disabled={busy !== null} onPress={() => void replay()} />
        ) : null}
      </View>

      {explained ? <ExplainResult read={explained} timezone={timezone} /> : null}
      {replayed ? <ReplayResult read={replayed} /> : null}
    </View>
  );
}

function ExplainResult({ read, timezone }: { read: LayoverDecisionExplainRead; timezone: string | null }) {
  if (read.ok) {
    const e = read.explanation;
    const r = e.decision?.result;
    return (
      <View style={styles.result} testID="layover-decision-explanation">
        <Text style={styles.label}>FROM PORTAVA&apos;S RECORD</Text>
        <Text style={styles.line} testID="layover-decision-verified">
          {e.verifiedBy === 'replay_match'
            ? 'Checked: re-run from the facts it was given, the stored answer comes out exactly the same.'
            : `Stored answer (${e.verifiedBy}).`}
        </Text>
        {r ? (
          <Text style={styles.line} testID="layover-decision-stored-deadline">
            Be back at the airport by {fmtClock(r.hardReturnTime, timezone)} · usable time {fmtDur(r.usableMinutes)}
          </Text>
        ) : null}
        {e.reasons.length > 0 ? (
          <View testID="layover-decision-reasons">
            <Text style={styles.label}>WHY</Text>
            {e.reasons.map((x, i) => <Text key={`r${i}`} style={styles.line}>• {x}</Text>)}
          </View>
        ) : null}
        {e.unknowns.length > 0 ? (
          <View testID="layover-decision-unknowns">
            <Text style={styles.label}>WHAT WE CAN&apos;T KNOW</Text>
            {e.unknowns.map((x, i) => <Text key={`u${i}`} style={styles.line}>• {x}</Text>)}
          </View>
        ) : null}
        {e.disclaimer ? <Text style={styles.mute}>{e.disclaimer}</Text> : null}
        <Text style={styles.mute} testID="layover-decision-provenance">
          Recorded {fmtClock(e.decision?.computedAt, timezone)} · engine {e.decision?.engineVersion ?? 'not stated'}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.result} testID={`layover-decision-explain-${read.kind}`}>
      <Text style={styles.line}>
        {read.kind === 'unavailable'
          ? unavailableSentence(read.reason)
          : read.kind === 'not_explained'
            ? notExplainedSentence(read.reason, read.detail)
            : read.kind === 'gone'
              ? 'Portava has no stored record of this answer.'
              : read.message}
      </Text>
    </View>
  );
}

function ReplayResult({ read }: { read: LayoverDecisionReplayRead }) {
  if (read.ok) {
    return (
      <View style={styles.result} testID="layover-decision-replay-summary">
        <Text style={styles.label}>RE-CHECKED</Text>
        {replaySentences(read).map((x, i) => <Text key={i} style={styles.line}>{x}</Text>)}
      </View>
    );
  }
  return (
    <View style={styles.result} testID={`layover-decision-replay-${read.kind}`}>
      <Text style={styles.line}>
        {read.kind === 'unavailable'
          ? unavailableSentence(read.reason)
          : read.kind === 'not_replayed'
            ? `These answers were made by a different version of Portava's engine${read.runningEngineVersion ? ` (this server runs ${read.runningEngineVersion})` : ''}, so they cannot be re-run here.`
            : read.kind === 'gone'
              ? 'Portava has no stored record for this layover.'
              : read.message}
      </Text>
    </View>
  );
}

function RecordButton({ testID, label, busy, disabled, onPress }: {
  testID: string; label: string; busy: boolean; disabled: boolean; onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy }}
      testID={testID}
      style={[styles.btn, disabled && !busy && styles.btnDim]}
      disabled={disabled}
      onPress={onPress}
    >
      {busy ? <ActivityIndicator size="small" color={color.ink} /> : <Text style={styles.btnText}>{label}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card:    { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.sm },
  head:    { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title:   { ...t.bodyStrong, color: color.ink, flex: 1 },
  sub:     { ...t.small, color: color.mute },
  row:     { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  result:  { backgroundColor: color.paper, borderRadius: radius.sm, padding: space.md, gap: 4 },
  label:   { ...t.stamp, color: color.mute },
  line:    { ...t.small, color: color.ink },
  mute:    { ...t.small, color: color.mute },
  btn:     { borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: space.sm, minWidth: 64, alignItems: 'center' },
  btnDim:  { opacity: 0.4 },
  btnText: { ...t.small, color: color.ink, fontWeight: '600' },
});
