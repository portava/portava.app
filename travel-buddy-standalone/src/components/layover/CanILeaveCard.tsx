/**
 * CanILeaveCard — "Can I leave the airport?" verdict with the honest
 * breakdown: reasons, hard numbers, what we can't know (visas!), and the
 * guidance disclaimer.
 */
import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { ChevronDown, ChevronUp, DoorOpen, HelpCircle } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens';
import { fmtClock, fmtDur } from './layoverFormat';
import type { LeaveAdvice, LayoverWindow, PublicAirport } from '../../services/layover';

interface Props {
  advice: LeaveAdvice;
  window: LayoverWindow;
  airport: PublicAirport;
}

const VERDICT: Record<LeaveAdvice['verdict'], { label: string; bg: string; fg: string }> = {
  yes:         { label: 'Yes — you have time',      bg: 'rgba(46,125,91,0.12)',  fg: color.success },
  tight:       { label: 'Tight — stay close',       bg: 'rgba(200,133,26,0.14)', fg: color.warn },
  no:          { label: 'No — stay airside',        bg: 'rgba(255,77,46,0.12)',  fg: color.signalDim },
  stay_airside:{ label: 'Staying in — good call',   bg: 'rgba(10,61,74,0.10)',   fg: color.deep },
};

export function CanILeaveCard({ advice, window: win, airport }: Props) {
  const [expanded, setExpanded] = useState(false);
  const v = VERDICT[advice.verdict];

  return (
    <View style={styles.card}>
      <View style={styles.headRow}>
        <DoorOpen size={18} color={color.ink} />
        <Text style={styles.heading}>Can I leave the airport?</Text>
      </View>

      <View style={[styles.verdictPill, { backgroundColor: v.bg }]}>
        <Text style={[styles.verdictText, { color: v.fg }]}>{v.label}</Text>
      </View>

      {advice.reasons.map((r) => (
        <Text key={r} style={styles.reason}>·  {r}</Text>
      ))}

      {/* Numbers */}
      <View style={styles.numbersRow}>
        <View style={styles.numBox}>
          <Text style={styles.numValue}>{fmtDur(win.usableMinutes)}</Text>
          <Text style={styles.numLabel}>usable out{'\n'}of the airport</Text>
        </View>
        <View style={styles.numBox}>
          <Text style={styles.numValue}>{fmtClock(win.earliestOutTime, airport.timezone)}</Text>
          <Text style={styles.numLabel}>earliest you're{'\n'}out the door</Text>
        </View>
        <View style={styles.numBox}>
          <Text style={[styles.numValue, { color: color.signalDim }]}>{fmtClock(win.hardReturnTime, airport.timezone)}</Text>
          <Text style={styles.numLabel}>hard return{'\n'}deadline</Text>
        </View>
      </View>

      {/* Breakdown accordion */}
      <Pressable style={styles.expandRow} onPress={() => setExpanded((e) => !e)}>
        <Text style={styles.expandText}>How we got these numbers</Text>
        {expanded ? <ChevronUp size={15} color={color.mute} /> : <ChevronDown size={15} color={color.mute} />}
      </Pressable>
      {expanded && (
        <View style={styles.breakdown}>
          {[
            ['Total layover', fmtDur(win.totalMinutes)],
            ['Getting out (deplane, exit)', fmtDur(win.exitDelayMin)],
            ['Security & boarding buffer', fmtDur(win.breakdown.totalBuffer)],
            win.breakdown.immigrationExtra > 0 ? ['· of which immigration', fmtDur(win.breakdown.immigrationExtra)] : null,
            win.breakdown.timeOfDayExtra > 0 ? ['· late-night extra', fmtDur(win.breakdown.timeOfDayExtra)] : null,
            ['Left for the city', fmtDur(win.usableMinutes)],
          ].filter((x): x is [string, string] => x !== null).map(([k, val]) => (
            <View key={k} style={styles.bkRow}>
              <Text style={styles.bkKey}>{k}</Text>
              <Text style={styles.bkVal}>{val}</Text>
            </View>
          ))}
        </View>
      )}

      {/* Unknowns — always visible, never buried */}
      <View style={styles.unknownBox}>
        <View style={styles.unknownHead}>
          <HelpCircle size={14} color={color.warn} />
          <Text style={styles.unknownTitle}>What we can't know</Text>
        </View>
        {advice.unknowns.map((u) => (
          <Text key={u} style={styles.unknownText}>— {u}</Text>
        ))}
      </View>

      <Text style={styles.disclaimer}>{advice.disclaimer}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card:       { backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, padding: space.lg, gap: space.sm },
  headRow:    { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  heading:    { ...t.heading, color: color.ink },
  verdictPill:{ alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: space.md, paddingVertical: 6 },
  verdictText:{ ...t.bodyStrong },
  reason:     { ...t.small, color: color.mute },

  numbersRow: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  numBox:     { flex: 1, backgroundColor: color.paper, borderRadius: radius.md, padding: space.md, alignItems: 'center', gap: 4 },
  numValue:   { ...t.heading, color: color.ink, fontVariant: ['tabular-nums'] },
  numLabel:   { ...t.stamp, color: color.faint, textAlign: 'center' },

  expandRow:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: space.xs },
  expandText: { ...t.small, color: color.mute, fontWeight: '600' },
  breakdown:  { backgroundColor: color.paper, borderRadius: radius.md, padding: space.md, gap: 6 },
  bkRow:      { flexDirection: 'row', justifyContent: 'space-between' },
  bkKey:      { ...t.small, color: color.mute },
  bkVal:      { ...t.small, color: color.ink, fontWeight: '600', fontVariant: ['tabular-nums'] },

  unknownBox: { backgroundColor: 'rgba(200,133,26,0.08)', borderRadius: radius.md, padding: space.md, gap: 4, marginTop: space.xs },
  unknownHead:{ flexDirection: 'row', alignItems: 'center', gap: 6 },
  unknownTitle:{ ...t.bodyStrong, color: color.warn },
  unknownText:{ ...t.small, color: color.mute },

  disclaimer: { ...t.small, color: color.faint, fontStyle: 'italic' },
});
