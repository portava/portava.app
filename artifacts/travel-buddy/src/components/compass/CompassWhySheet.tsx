/**
 * CompassWhySheet — "Why am I seeing this?" bottom sheet.
 *
 * Fetches the explanation from GET /api/compass/why/:recommendationId and
 * displays it with a dismiss button.
 */
import React, { useEffect } from 'react';
import {
  View, Text, Pressable, Modal, StyleSheet, ActivityIndicator,
} from 'react-native';
import { Sparkles, X } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens';
import { useCompassWhyExplanation } from '../../hooks/compass/useCompassWhyExplanation';

interface Props {
  visible:          boolean;
  recommendationId: string | null;
  onClose:          () => void;
}

export function CompassWhySheet({ visible, recommendationId, onClose }: Props) {
  const { explanation, loading, fetch, clear } = useCompassWhyExplanation();

  useEffect(() => {
    if (visible && recommendationId) {
      fetch(recommendationId);
    } else if (!visible) {
      clear();
    }
  }, [visible, recommendationId]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View style={styles.sheet}>
          <View style={styles.handle} />

          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <Sparkles size={18} color={color.signal} />
              <Text style={styles.title}>Why am I seeing this?</Text>
            </View>
            <Pressable onPress={onClose} hitSlop={8}>
              <X size={20} color={color.mute} />
            </Pressable>
          </View>

          {/* Body */}
          {loading ? (
            <View style={styles.loadingWrap}>
              <ActivityIndicator size="small" color={color.signal} />
            </View>
          ) : (
            <View style={styles.body}>
              <Text style={styles.explanation}>
                {explanation ?? 'Based on your travel preferences and recent activity.'}
              </Text>
              <Text style={styles.sub}>
                Tap "Show more like this" or "Show less like this" from the ⋯ menu to
                teach Compass what you prefer.
              </Text>
            </View>
          )}

          <Pressable style={styles.dismissBtn} onPress={onClose}>
            <Text style={styles.dismissText}>Got it</Text>
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: color.paper,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: space.lg,
    paddingBottom: 36,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.haze,
    alignSelf: 'center',
    marginTop: space.md,
    marginBottom: space.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.lg,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  title: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 16,
  },
  loadingWrap: {
    paddingVertical: space.xxl,
    alignItems: 'center',
  },
  body: {
    gap: space.md,
    marginBottom: space.xl,
  },
  explanation: {
    ...t.body,
    color: color.ink,
    lineHeight: 22,
  },
  sub: {
    ...t.small,
    color: color.mute,
    lineHeight: 18,
  },
  dismissBtn: {
    backgroundColor: color.signal,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: 'center',
  },
  dismissText: {
    ...t.bodyStrong,
    color: '#fff',
    fontSize: 15,
  },
});
