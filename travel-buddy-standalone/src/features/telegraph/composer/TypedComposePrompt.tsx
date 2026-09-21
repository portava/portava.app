/**
 * Telegraph §6.1 → §6.2 — the small compose sheets behind two of the `+`
 * menu's entries.
 *
 *   Location    -> a §6.2 LOCATION message, COARSE by default (§4.3)
 *   Memory Note -> a §6.2 MEMORY_NOTE message (§10.1's MemoryNoteShare)
 *
 * §4.3's "approximate proximity or controlled distance buckets by default" is
 * enforced HERE, at the point of authorship: the precision selector opens on
 * "Approximate area", and choosing "Exact" is a deliberate second tap. Nothing
 * in this sheet reads the device's GPS — the label is what the sender types,
 * so an exact coordinate can only enter a thread through a surface that asked
 * for it explicitly.
 */
import React, { useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { space, radius, type as t } from '../../../theme/tokens.ts';
import { useTelegraphPalette, type TelegraphPalette } from '../theme/telegraphTheme.ts';
import type { SendableKind } from '../kinds/kindsApi.ts';

export type TypedComposeKind = 'LOCATION' | 'MEMORY_NOTE';

export interface TypedComposePromptProps {
  kind: TypedComposeKind | null;
  onCancel: () => void;
  onSubmit: (kind: SendableKind, payload: unknown) => void;
  /** Used as MEMORY_NOTE's authorId; the server re-derives the sender anyway. */
  authorId: string | null;
}

const PRECISIONS = [
  { id: 'area', label: 'Approximate area' },
  { id: 'venue', label: 'Venue' },
  { id: 'exact', label: 'Exact' },
] as const;

export function TypedComposePrompt({ kind, onCancel, onSubmit, authorId }: TypedComposePromptProps) {
  const palette = useTelegraphPalette();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const [text, setText] = useState('');
  const [precision, setPrecision] = useState<'area' | 'venue' | 'exact'>('area');

  const close = () => {
    setText('');
    setPrecision('area');
    onCancel();
  };

  const submit = () => {
    const value = text.trim();
    if (value.length === 0) return;
    if (kind === 'LOCATION') {
      onSubmit('LOCATION', { label: value, precision });
    } else {
      onSubmit('MEMORY_NOTE', {
        memoryNoteId: `note-${Date.now()}`,
        authorId: authorId ?? 'me',
        text: value,
        mediaAssetIds: [],
      });
    }
    setText('');
    setPrecision('area');
  };

  return (
    <Modal visible={kind !== null} transparent animationType="slide" onRequestClose={close}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} testID="telegraph-typed-compose">
          <Text style={styles.heading}>
            {kind === 'LOCATION' ? 'Share a location' : 'Write a Memory Note'}
          </Text>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={kind === 'LOCATION' ? 'Where? e.g. An Thuong' : 'What happened?'}
            placeholderTextColor={palette.mute}
            style={styles.input}
            multiline={kind === 'MEMORY_NOTE'}
            accessibilityLabel={kind === 'LOCATION' ? 'Location label' : 'Memory note text'}
            testID="telegraph-typed-compose-input"
          />
          {kind === 'LOCATION' ? (
            <View style={styles.row}>
              {PRECISIONS.map((p) => (
                <Pressable
                  key={p.id}
                  testID={`telegraph-precision-${p.id}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: precision === p.id }}
                  accessibilityLabel={p.label}
                  onPress={() => setPrecision(p.id)}
                  style={[styles.chip, precision === p.id ? styles.chipActive : null]}
                >
                  <Text style={[styles.chipText, precision === p.id ? styles.chipTextActive : null]}>
                    {p.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          <View style={styles.actions}>
            <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={close} style={styles.secondary}>
              <Text style={styles.secondaryText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send"
              onPress={submit}
              style={styles.primary}
              testID="telegraph-typed-compose-send"
            >
              <Text style={styles.primaryText}>Send</Text>
            </Pressable>
          </View>
        </View>
      </View>
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
    heading: { ...t.body, color: p.recvText, fontWeight: '800' },
    input: {
      backgroundColor: p.surfaceRaised,
      borderWidth: 1,
      borderColor: p.hairline,
      borderRadius: radius.md,
      paddingHorizontal: space.md,
      paddingVertical: 10,
      color: p.recvText,
      minHeight: 44,
    },
    row: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
    chip: {
      paddingHorizontal: space.md,
      paddingVertical: 5,
      borderRadius: radius.pill,
      backgroundColor: p.chipFill,
    },
    chipActive: { backgroundColor: p.operational },
    chipText: { ...t.small, color: p.mute },
    chipTextActive: { color: p.operationalOn, fontWeight: '700' },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm },
    secondary: { paddingHorizontal: space.lg, paddingVertical: 8 },
    secondaryText: { ...t.small, color: p.mute },
    primary: {
      paddingHorizontal: space.lg,
      paddingVertical: 8,
      borderRadius: radius.pill,
      backgroundColor: p.operational,
    },
    primaryText: { ...t.small, color: p.operationalOn, fontWeight: '700' },
  });
}

export default TypedComposePrompt;
