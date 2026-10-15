/**
 * LayoverCrewAbortToggle — census-layover L144, the traveller's OWN per-abort
 * choice to tell their crew they are heading back.
 *
 * ── WHEN IT EXISTS AT ALL ────────────────────────────────────────────────────
 * Only when the overview says the server would honour it
 * (`crewAbortNotice.available === true`: the flag `layover_crew_abort_notify_enabled`
 * is on AND the traveller is in a live crew joined with this session, with
 * someone else in it). Absent field (a pre-L144 server), `available: false`, or
 * no field at all: nothing renders, so a traveller is never offered a choice the
 * server would ignore.
 *
 * ── WHAT IT DOES NOT DO ──────────────────────────────────────────────────────
 * It sends nothing. It only sets `tellCrew` on the screen's abort controller
 * (`useSafeReturnAbort`), which sends `tellCrew: true` with the NEXT press and
 * resets the choice after it. Unticked is the default and the reset state:
 * telling the crew is a disclosure about this traveller, and the owner has not
 * decided it may happen without being asked (OQ-3).
 *
 * The sub-line states the whole disclosure, so the traveller knows what their
 * crewmates will read before they choose.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Square, SquareCheck } from 'lucide-react-native';
import { color, space, type as t } from '../../theme/tokens.ts';
import type { LayoverOverview } from '../../services/layover.ts';
import type { SafeReturnAbortController } from './useSafeReturnAbort.ts';

interface Props {
  overview: LayoverOverview;
  controller: SafeReturnAbortController;
}

/** True only for an explicit server yes. */
export function crewAbortNoticeOffered(overview: LayoverOverview): boolean {
  return overview.crewAbortNotice?.available === true;
}

export function LayoverCrewAbortToggle({ overview, controller }: Props) {
  if (!crewAbortNoticeOffered(overview)) return null;
  const on = controller.tellCrew === true;
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on, disabled: controller.busy }}
      accessibilityLabel="Tell my crew I'm heading back to the airport"
      accessibilityHint="Your crewmates will see only that you are heading back to the airport."
      testID="abort-tell-crew-toggle"
      style={styles.row}
      disabled={controller.busy}
      onPress={() => controller.setTellCrew(!on)}
    >
      {on ? <SquareCheck size={18} color={color.ink} /> : <Square size={18} color={color.mute} />}
      <View style={styles.text}>
        <Text style={styles.label}>Tell my crew I'm heading back</Text>
        <Text style={styles.sub} testID="abort-tell-crew-disclosure">
          They will see only that you are heading back to the airport — no place, time or reason.
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row:   { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: space.md },
  text:  { flex: 1, gap: 2 },
  label: { ...t.bodyStrong, color: color.ink },
  sub:   { ...t.small, color: color.mute },
});
