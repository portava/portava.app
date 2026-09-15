/**
 * LayoverEndSheet — how this layover ended, and whether to keep a stamp of it.
 *
 * ── WHY THIS IS NOT A ConfirmSheet, AND NOT AN Alert ─────────────────────────
 * Closing a layover carries TWO independent answers (census L19, L162):
 *
 *   1. the OUTCOME — "I made my flight" is `completed`, "ending early" is
 *      `cancelled`. Until this sheet existed the client sent neither: every
 *      close was recorded as an abandonment, including a traveller who came
 *      back and boarded.
 *   2. the ELECTION — whether a durable `passport_stamps` row is written for
 *      the city. The app used to mint one at session CREATION, for a city
 *      nobody had been to yet, with nothing asked and nothing that removed it.
 *
 * `ConfirmSheet` carries one yes/no and `Alert.alert` would need a second
 * chained dialog, which presents two independent decisions as one. So this is
 * its own sheet, and — unlike the rest of this surface — it is used on NATIVE
 * as well as web: the platform idiom argument applies to a confirmation, and
 * this is a form.
 *
 * THE ELECTION DEFAULTS TO OFF and is only offered on the `completed` branch.
 * A pre-ticked box is not a choice, and a stamp for a layover the traveller
 * abandoned is the artifact the census objected to in the first place.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, Modal, StyleSheet } from 'react-native';
import { Check, PlaneTakeoff, XCircle } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

export interface LayoverEndSheetProps {
  visible: boolean;
  /** City the stamp would carry. `null` hides the election — there is nothing to stamp. */
  stampCity: string | null;
  busy?: boolean;
  onCancel: () => void;
  onEnd: (choice: { outcome: 'completed' | 'cancelled'; passportStamp: boolean }) => void;
}

export function LayoverEndSheet({ visible, stampCity, busy = false, onCancel, onEnd }: LayoverEndSheetProps) {
  const [keepStamp, setKeepStamp] = useState(false);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel} accessibilityLabel="Keep going">
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()} testID="layover-end-sheet">
          <Text style={styles.title}>How did this layover end?</Text>
          <Text style={styles.body}>Your plan stays saved in your history either way.</Text>

          {stampCity && (
            <Pressable
              style={styles.electionRow}
              onPress={() => setKeepStamp((v) => !v)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: keepStamp }}
              testID="layover-end-stamp-election"
            >
              <View style={[styles.checkbox, keepStamp && styles.checkboxOn]}>
                {keepStamp ? <Check size={13} color={color.paper} /> : null}
              </View>
              <Text style={styles.electionText}>
                Add {stampCity} to my Passport{'\n'}
                <Text style={styles.electionHint}>Only if you made your flight. Off by default.</Text>
              </Text>
            </Pressable>
          )}

          <Pressable
            style={[styles.btn, styles.primary, busy && styles.btnDisabled]}
            onPress={() => onEnd({ outcome: 'completed', passportStamp: keepStamp })}
            disabled={busy}
            accessibilityRole="button"
            testID="layover-end-completed"
          >
            <PlaneTakeoff size={15} color={color.paper} />
            <Text style={styles.primaryText}>{busy ? 'Ending…' : 'I made my flight'}</Text>
          </Pressable>

          <Pressable
            style={[styles.btn, busy && styles.btnDisabled]}
            onPress={() => onEnd({ outcome: 'cancelled', passportStamp: false })}
            disabled={busy}
            accessibilityRole="button"
            testID="layover-end-cancelled"
          >
            <XCircle size={15} color={color.signalDim} />
            <Text style={styles.destructiveText}>I'm ending it early</Text>
          </Pressable>

          <Pressable style={styles.btn} onPress={onCancel} accessibilityRole="button" testID="layover-end-keep-going">
            <Text style={styles.cancelText}>Keep going</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop:  { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet:     { backgroundColor: color.paperRaised, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: space.lg, gap: space.sm },
  title:     { ...t.heading, color: color.ink },
  body:      { ...t.small, color: color.mute },

  electionRow:  { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, backgroundColor: color.paper, borderRadius: radius.md, padding: space.md, marginTop: space.xs },
  checkbox:     { width: 20, height: 20, borderRadius: 6, borderWidth: 1, borderColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  checkboxOn:   { backgroundColor: color.deep, borderColor: color.deep },
  electionText: { ...t.small, color: color.ink, flex: 1 },
  electionHint: { ...t.stamp, color: color.faint },

  btn:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm, paddingVertical: space.md, borderRadius: radius.md },
  btnDisabled:{ opacity: 0.5 },
  primary:    { backgroundColor: color.deep },
  primaryText:{ ...t.bodyStrong, color: color.paper },
  destructiveText: { ...t.bodyStrong, color: color.signalDim },
  cancelText: { ...t.body, color: color.mute },
});
