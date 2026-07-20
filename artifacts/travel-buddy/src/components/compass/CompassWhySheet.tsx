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
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import { useCompassWhyExplanation } from '../../hooks/compass/useCompassWhyExplanation.ts';

interface Props {
  visible:          boolean;
  recommendationId: string | null;
  onClose:          () => void;
}

export function CompassWhySheet({ visible, recommendationId, onClose }: Props) {
  const {
    explanation, factors, compassMatch, communityScore, loading, fetch, clear,
  } = useCompassWhyExplanation();

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

              {/* Phase 7 — two independent signals */}
              {(compassMatch != null || communityScore != null) && (
                <View style={styles.scoresRow}>
                  {compassMatch != null && (
                    <View style={styles.scorePill} testID="compass-match-pill">
                      <Text style={styles.scoreValue}>{compassMatch}</Text>
                      <Text style={styles.scoreLabel}>Compass Match</Text>
                    </View>
                  )}
                  {communityScore != null && (
                    <View style={styles.scorePill} testID="community-score-pill">
                      <Text style={styles.scoreValue}>{communityScore}</Text>
                      <Text style={styles.scoreLabel}>Community Score</Text>
                    </View>
                  )}
                </View>
              )}

              {/* Phase 7 — grounded ranking factors */}
              {factors.length > 0 && (
                <View style={styles.factorList}>
                  {factors.map((f) => (
                    <View key={f.key} style={styles.factorRow} testID={`why-factor-${f.key}`}>
                      <View style={styles.factorDot} />
                      <Text style={styles.factorText}>
                        {f.label}
                        {f.detail ? ` — ${f.detail}` : ''}
                      </Text>
                    </View>
                  ))}
                </View>
              )}

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
  scoresRow: {
    flexDirection: 'row',
    gap: space.sm,
  },
  scorePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: color.haze,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: 8,
  },
  scoreValue: {
    ...t.bodyStrong,
    color: color.signal,
    fontSize: 15,
  },
  scoreLabel: {
    ...t.small,
    color: color.ink,
  },
  factorList: {
    gap: 6,
  },
  factorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  factorDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: color.signal,
  },
  factorText: {
    ...t.small,
    color: color.ink,
    lineHeight: 18,
    flex: 1,
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
