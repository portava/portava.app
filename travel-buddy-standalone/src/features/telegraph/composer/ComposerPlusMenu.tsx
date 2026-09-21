/**
 * Telegraph §6.1 — the composer's `+` menu.
 *
 * "The composer remains visually calm; rich actions live behind the + menu."
 *
 * The menu renders §6.1's EIGHT entries from `composerMenu.ts`. An entry that
 * cannot complete in this tree is rendered DISABLED with its reason, not
 * hidden: hiding it would make the menu look finished, and a traveler who taps
 * Voice deserves to be told why it is greyed out rather than to discover it
 * after recording.
 */
import React, { useMemo } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { space, radius, type as t } from '../../../theme/tokens.ts';
import { useTelegraphPalette, type TelegraphPalette } from '../theme/telegraphTheme.ts';
import { COMPOSER_ENTRIES, type ComposerEntry, type ComposerEntryId } from './composerMenu.ts';

export interface ComposerPlusMenuProps {
  visible: boolean;
  onClose: () => void;
  onSelect: (id: ComposerEntryId) => void;
  /** Shown when a disabled entry is tapped; defaults to the entry's reason. */
  onUnavailable?: (entry: ComposerEntry) => void;
}

export function ComposerPlusMenu({ visible, onClose, onSelect, onUnavailable }: ComposerPlusMenuProps) {
  const palette = useTelegraphPalette();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} accessibilityLabel="Close menu" onPress={onClose}>
        <View style={styles.sheet} testID="telegraph-composer-plus-menu">
          <Text style={styles.heading}>Add to this message</Text>
          <View style={styles.grid}>
            {COMPOSER_ENTRIES.map((entry) => (
              <Pressable
                key={entry.id}
                testID={`telegraph-composer-entry-${entry.id}`}
                accessibilityRole="button"
                accessibilityLabel={entry.label}
                // NOT accessibilityState.disabled: the entry is deliberately
                // still pressable, because pressing it is how the traveler
                // learns WHY it cannot complete. The hint carries the reason.
                accessibilityHint={entry.unavailableReason ?? undefined}
                style={[styles.cell, entry.available ? null : styles.cellDisabled]}
                onPress={() => {
                  if (!entry.available) {
                    onUnavailable?.(entry);
                    return;
                  }
                  onSelect(entry.id);
                }}
              >
                <Text style={[styles.cellText, entry.available ? null : styles.cellTextDisabled]}>
                  {entry.label}
                </Text>
                {/* The reason is rendered INLINE, not behind a tap. An entry a
                    traveler cannot use should say why before they try it. */}
                {entry.unavailableReason ? (
                  <Text
                    style={styles.notice}
                    testID={`telegraph-composer-reason-${entry.id}`}
                    numberOfLines={3}
                  >
                    {entry.unavailableReason}
                  </Text>
                ) : null}
              </Pressable>
            ))}
          </View>
        </View>
      </Pressable>
    </Modal>
  );
}

function makeStyles(p: TelegraphPalette) {
  return StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)', justifyContent: 'flex-end' },
    sheet: {
      backgroundColor: p.surface,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      padding: space.lg,
      gap: space.md,
    },
    heading: { ...t.small, color: p.mute, letterSpacing: 0.4 },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
    cell: {
      minWidth: '46%',
      flexGrow: 1,
      paddingVertical: space.md,
      paddingHorizontal: space.md,
      borderRadius: radius.md,
      backgroundColor: p.surfaceRaised,
      borderWidth: 1,
      borderColor: p.hairline,
    },
    cellDisabled: { opacity: 0.55 },
    cellText: { ...t.body, color: p.recvText, fontWeight: '600' },
    cellTextDisabled: { color: p.mute },
    notice: { ...t.small, color: p.mute },
  });
}

export default ComposerPlusMenu;
