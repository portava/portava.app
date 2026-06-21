import React, { useState } from 'react';
import {
  View, Text, Pressable, TextInput, Modal, StyleSheet,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { MapPin, ChevronDown, X, Search } from 'lucide-react-native';
import { color, space, radius, type as t, shadow } from '../../theme/tokens';

interface DestinationBarProps {
  destination: string;
  onChangeDestination: (dest: string) => void;
}

export function DestinationBar({ destination, onChangeDestination }: DestinationBarProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState(destination);

  const open = () => {
    setDraft(destination);
    setModalOpen(true);
  };

  const apply = () => {
    const trimmed = draft.trim();
    if (trimmed) onChangeDestination(trimmed);
    setModalOpen(false);
  };

  return (
    <>
      <Pressable style={styles.bar} onPress={open}>
        <MapPin size={14} color={color.signal} />
        <Text style={styles.dest} numberOfLines={1}>
          {destination || 'Pick a destination'}
        </Text>
        <ChevronDown size={14} color={color.mute} />
      </Pressable>

      <Modal
        visible={modalOpen}
        animationType="fade"
        transparent
        statusBarTranslucent
        onRequestClose={() => setModalOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setModalOpen(false)} />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.kav}
        >
          <View style={styles.dialog}>
            <View style={styles.dialogHeader}>
              <Text style={styles.dialogTitle}>Search destination</Text>
              <Pressable onPress={() => setModalOpen(false)} hitSlop={8}>
                <X size={20} color={color.ink} />
              </Pressable>
            </View>

            <View style={styles.inputRow}>
              <Search size={16} color={color.faint} />
              <TextInput
                style={styles.input}
                value={draft}
                onChangeText={setDraft}
                placeholder="City, island or region…"
                placeholderTextColor={color.faint}
                returnKeyType="search"
                autoFocus
                onSubmitEditing={apply}
              />
            </View>

            <Text style={styles.hint}>
              Try "Paris", "Bali", "Palawan" or any city name.
            </Text>

            <Pressable style={styles.applyBtn} onPress={apply}>
              <Text style={styles.applyText}>Explore</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 2,
    backgroundColor: color.haze,
    borderRadius: radius.pill,
    flexShrink: 1,
    maxWidth: 200,
  },
  dest: {
    ...t.small,
    color: color.ink,
    fontWeight: '600',
    fontSize: 13,
    flex: 1,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  kav: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  dialog: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.md,
    ...shadow.float,
  },
  dialogHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dialogTitle: {
    ...t.bodyStrong,
    color: color.ink,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.haze,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
  },
  input: {
    ...t.body,
    color: color.ink,
    flex: 1,
    padding: 0,
  },
  hint: {
    ...t.small,
    color: color.faint,
    fontSize: 12,
  },
  applyBtn: {
    backgroundColor: color.signal,
    borderRadius: radius.md,
    paddingVertical: space.md,
    alignItems: 'center',
  },
  applyText: {
    ...t.bodyStrong,
    color: color.onInk,
    fontWeight: '700',
  },
});

export default DestinationBar;
