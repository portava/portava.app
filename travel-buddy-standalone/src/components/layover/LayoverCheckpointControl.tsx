/**
 * LayoverCheckpointControl — "I've left the airport" / "I'm back at the airport".
 * census-layover L30 / L173 / L43, Layover spec §4 `layover_checkpoints` and
 * Appendix B.1 step 9 ("Airport re-entry checkpoint transitions to
 * AIRPORT_REENTERED").
 *
 * The traveller is the only observer this tree has (no location sensing on this
 * surface — census L164 — and no airport feed), so a checkpoint is their own
 * report. It is kept with the layover's record and fills the outcome's "did
 * they leave / when were they back"; it NEVER moves the return time, and the
 * control says so, because a traveller who taps "I'm back" must not read it as
 * "the app now thinks I have more time".
 *
 * RENDERED ONLY WHEN THE SERVER SAYS THE STORE IS ON. The store is migration
 * 2992's, behind its write gate, and the overview already publishes that gate's
 * state (`persisted`). `checkpointCapability` reads it; an older server, or a
 * gate that is off, renders nothing rather than a control that can only fail.
 * Inside, the server's own `available: false` is honoured the same way.
 *
 * A failed read is a failure with a retry, never "you have reported nothing".
 * A failed report keeps its operation id, so the retry is the same report.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { color, radius, space, type as t } from '../../theme/tokens.ts';
import {
  getLayoverCheckpoints,
  reportLayoverCheckpoint,
  type LayoverCheckpointsRead,
  type TravellerCheckpointType,
} from '../../services/layover.ts';
import { fmtClock } from './layoverFormat.ts';

/** 'on' only when the overview says 2992's gate is not off. Absent = unknown = hidden. */
export function checkpointCapability(overview: { persisted?: { state?: string; reason?: string } | null }): 'on' | 'off' | 'unknown' {
  const p = overview.persisted;
  if (!p || typeof p.state !== 'string') return 'unknown';
  if (p.state === 'not_stored' && p.reason === 'persistence_disabled') return 'off';
  return 'on';
}

function newOperationId(): string {
  return `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const LABEL: Record<TravellerCheckpointType, string> = {
  LANDSIDE_EXIT: "I've left the airport",
  AIRPORT_REENTRY: "I'm back at the airport",
};

interface Props {
  sessionId: string;
  /** A layover that has ended takes no reports (the server refuses them too). */
  canReport: boolean;
  timezone: string | null;
}

export function LayoverCheckpointControl({ sessionId, canReport, timezone }: Props) {
  const [read, setRead] = useState<LayoverCheckpointsRead | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const pendingOp = useRef<{ type: TravellerCheckpointType; id: string } | null>(null);
  const ticket = useRef(0);

  const load = useCallback(async () => {
    const mine = ++ticket.current;
    const r = await getLayoverCheckpoints(sessionId);
    if (mine === ticket.current) setRead(r);
  }, [sessionId]);

  useEffect(() => { void load(); }, [load]);

  const report = useCallback(async (type: TravellerCheckpointType) => {
    // Same tap retried → same operation id → same row on the server.
    if (!pendingOp.current || pendingOp.current.type !== type) pendingOp.current = { type, id: newOperationId() };
    setBusy(true);
    setNotice(null);
    try {
      const r = await reportLayoverCheckpoint(sessionId, type, pendingOp.current.id);
      if (r.ok) {
        pendingOp.current = null;
        await load();
      } else {
        setNotice(r.message);
      }
    } finally {
      setBusy(false);
    }
  }, [sessionId, load]);

  if (!read) {
    return <ActivityIndicator size="small" color={color.mute} testID="layover-checkpoints-loading" />;
  }
  if (read.ok && !read.available) return null;
  if (!read.ok) {
    return (
      <View style={styles.box} testID="layover-checkpoints-unavailable">
        <Text style={styles.body}>{read.message}</Text>
        <Pressable onPress={() => void load()} accessibilityRole="button" testID="layover-checkpoints-retry">
          <Text style={styles.link}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  const latest = read.checkpoints[0] ?? null;
  const at = latest ? fmtClock(latest.observedAt, timezone ?? undefined) : null;
  const status = read.airportPresence === 'landside'
    ? `You told us you left the airport at ${at}.`
    : read.airportPresence === 'airside'
      ? `You told us you were back at the airport at ${at}.`
      : "Tell us when you leave the airport and when you're back. It is kept with this layover's record.";
  const next: TravellerCheckpointType = read.airportPresence === 'landside' ? 'AIRPORT_REENTRY' : 'LANDSIDE_EXIT';

  return (
    <View style={styles.box} testID="layover-checkpoints">
      <Text style={styles.body} testID="layover-checkpoints-status">{status}</Text>
      {canReport ? (
        <Pressable
          style={[styles.btn, busy && styles.btnBusy]}
          onPress={() => void report(next)}
          disabled={busy}
          accessibilityRole="button"
          testID={`layover-checkpoint-${next === 'LANDSIDE_EXIT' ? 'left' : 'back'}`}
        >
          <Text style={styles.btnText}>{busy ? 'Saving…' : LABEL[next]}</Text>
        </Pressable>
      ) : null}
      <Text style={styles.hint}>This does not change your return time.</Text>
      {notice ? <Text style={styles.notice} testID="layover-checkpoint-notice">{notice}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box:     { marginTop: space.sm, gap: space.xs, backgroundColor: color.paper, borderRadius: radius.md, padding: space.md },
  body:    { ...t.small, color: color.ink },
  hint:    { ...t.stamp, color: color.faint },
  link:    { ...t.small, color: color.signal },
  notice:  { ...t.small, color: color.warn },
  btn:     { alignItems: 'center', justifyContent: 'center', paddingVertical: space.sm, borderRadius: radius.md, backgroundColor: color.deep },
  btnBusy: { opacity: 0.5 },
  btnText: { ...t.bodyStrong, color: color.paper },
});
