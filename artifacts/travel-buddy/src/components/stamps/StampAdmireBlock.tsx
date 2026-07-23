/**
 * StampAdmireBlock — admire toggle + count for stamp detail surfaces.
 *
 * When getAdmirers returns null (feature flag off / unconfigured),
 * the block renders nothing — zero visual change for viewers on those paths.
 *
 * Owner view: count label only (no button). Count is pressable to open the
 *   admirers sheet when count > 0.
 * Viewer view: sparkle button + count. Tapping toggles optimistically and
 *   reverts on API failure.
 *
 * Reduced-motion: press-scale animation is skipped when useReducedMotion() is true.
 */
import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  View, Text, Pressable, Modal, Animated, StyleSheet, ActivityIndicator,
} from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import { Sparkles } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import {
  getAdmirers,
  admireStamp,
  unadmireStamp,
} from '../../services/stampAdmire.ts';
import type { StampAdmirer } from '../../services/stampAdmire.ts';
import { StampAdmirersSheet } from './StampAdmirersSheet.tsx';

interface Props {
  userStampId: string;
  isOwner: boolean;
}

interface AdmireState {
  count: number;
  admiredByMe: boolean;
  admirers: StampAdmirer[];
}

export function StampAdmireBlock({ userStampId, isOwner }: Props) {
  const [data, setData] = useState<AdmireState | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const reducedMotion = useReducedMotion();
  const scale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getAdmirers(userStampId).then((res) => {
      if (!alive) return;
      setLoading(false);
      if (res === null) {
        setData(null);
      } else {
        setData({ count: res.count, admiredByMe: res.admiredByMe, admirers: res.admirers });
      }
    }).catch(() => {
      if (alive) { setLoading(false); setData(null); }
    });
    return () => { alive = false; };
  }, [userStampId]);

  const animatePress = useCallback(() => {
    if (reducedMotion) return;
    Animated.sequence([
      Animated.timing(scale, { toValue: 0.82, duration: 80, useNativeDriver: true }),
      Animated.spring(scale, { toValue: 1, useNativeDriver: true }),
    ]).start();
  }, [reducedMotion, scale]);

  const handleToggle = useCallback(async () => {
    if (!data || toggling) return;
    animatePress();
    const wasAdmired = data.admiredByMe;
    const prevCount = data.count;
    // Optimistic update
    setData((prev) =>
      prev
        ? { ...prev, admiredByMe: !wasAdmired, count: wasAdmired ? prev.count - 1 : prev.count + 1 }
        : prev,
    );
    setToggling(true);
    const ok = wasAdmired
      ? await unadmireStamp(userStampId)
      : await admireStamp(userStampId);
    setToggling(false);
    if (!ok) {
      // Revert
      setData((prev) =>
        prev
          ? { ...prev, admiredByMe: wasAdmired, count: prevCount }
          : prev,
      );
    }
  }, [data, toggling, userStampId, animatePress]);

  // Still loading or feature off
  if (loading) return null;
  if (!data) return null;

  const { count, admiredByMe, admirers } = data;

  // Owner: show count-only (pressable) when count > 0, nothing when 0
  if (isOwner) {
    if (count === 0) return null;
    return (
      <View style={styles.wrap}>
        <Pressable
          style={styles.countOnlyBtn}
          onPress={() => setSheetOpen(true)}
          accessibilityLabel={`${count} admirer${count === 1 ? '' : 's'}`}
        >
          <Sparkles size={14} color={color.mute} />
          <Text style={styles.countText}>{count}</Text>
        </Pressable>
        <StampAdmirersSheet
          visible={sheetOpen}
          admirers={admirers}
          onClose={() => setSheetOpen(false)}
        />
      </View>
    );
  }

  // Non-owner view: admire button + count
  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        {/* Admire button */}
        <Animated.View style={{ transform: [{ scale }] }}>
          <Pressable
            style={[styles.admireBtn, admiredByMe && styles.admireBtnActive]}
            onPress={handleToggle}
            disabled={toggling}
            accessibilityLabel={admiredByMe ? 'Remove admire' : 'Admire this stamp'}
          >
            {toggling ? (
              <ActivityIndicator size="small" color={admiredByMe ? color.signal : color.mute} />
            ) : (
              <Sparkles
                size={16}
                color={admiredByMe ? color.signal : color.mute}
              />
            )}
            <Text style={[styles.admireBtnText, admiredByMe && styles.admireBtnTextActive]}>
              {admiredByMe ? 'Admired' : 'Admire'}
            </Text>
          </Pressable>
        </Animated.View>

        {/* Count — pressable to open admirers sheet when > 0 */}
        {count > 0 && (
          <Pressable
            style={styles.countBtn}
            onPress={() => setSheetOpen(true)}
            accessibilityLabel={`${count} admirer${count === 1 ? '' : 's'}`}
          >
            <Text style={styles.countText}>{count}</Text>
          </Pressable>
        )}
      </View>

      <StampAdmirersSheet
        visible={sheetOpen}
        admirers={admirers}
        onClose={() => setSheetOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: '100%', alignItems: 'flex-start', marginTop: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  admireBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: space.xs + 2,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paper,
    minHeight: 36,
  },
  admireBtnActive: {
    borderColor: color.signal,
    backgroundColor: '#FFF0F3',
  },
  admireBtnText: { ...t.small, color: color.mute, fontWeight: '600' },
  admireBtnTextActive: { color: color.signal },
  countBtn: {
    paddingVertical: space.xs,
    paddingHorizontal: space.sm,
  },
  countOnlyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: space.xs,
    paddingHorizontal: space.sm,
  },
  countText: { ...t.small, color: color.mute, fontWeight: '600' },
});
