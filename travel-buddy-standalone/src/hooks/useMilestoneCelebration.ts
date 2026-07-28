/**
 * useMilestoneCelebration
 *
 * Checks whether the current user has crossed a stamp milestone (100 / 1,000 /
 * 10,000) that hasn't been locally celebrated yet.  When one is found:
 *   - Fires the appropriate haptic
 *   - Starts the animation sequence for that tier
 *   - Marks the milestone in AsyncStorage so it never replays
 *
 * Only runs when `enabled` is true (i.e. viewing your own profile) and
 * `stampsEarned` has loaded (non-null).
 */
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';

export type MilestoneLevel = 100 | 1000 | 10000;

const milestoneStorageKey = (level: MilestoneLevel) =>
  `@portava/stamp_milestone_v1_${level}`;

export interface MilestoneCelebrationResult {
  /** The milestone currently being celebrated, or null when idle. */
  activeMilestone: MilestoneLevel | null;
  /** Animated value driving the sparkle pulse (100 milestone). 0 → 1 */
  sparkle: Animated.Value;
  /** Animated value driving the ink-ring expansion (1K milestone). 0 → 1 */
  inkRing: Animated.Value;
  /** Animated value driving the confetti burst (10K milestone). 0 → 1 */
  confetti: Animated.Value;
  /** Call after the overlay animation finishes to persist "seen" and reset. */
  onDismiss: () => void;
}

export function useMilestoneCelebration(
  stampsEarned: number | null,
  enabled: boolean,
): MilestoneCelebrationResult {
  const [activeMilestone, setActiveMilestone] = useState<MilestoneLevel | null>(null);
  const sparkle  = useRef(new Animated.Value(0)).current;
  const inkRing  = useRef(new Animated.Value(0)).current;
  const confetti = useRef(new Animated.Value(0)).current;
  // Prevents re-running the async check on every re-render once done.
  const checkedRef = useRef(false);

  useEffect(() => {
    if (!enabled || stampsEarned === null || checkedRef.current) return;
    checkedRef.current = true;

    const milestones: MilestoneLevel[] = [10000, 1000, 100];

    (async () => {
      for (const level of milestones) {
        if (stampsEarned < level) continue;

        const alreadySeen = await AsyncStorage.getItem(milestoneStorageKey(level)).catch(
          () => null,
        );
        if (alreadySeen) continue; // already celebrated locally

        // Found an uncelebrated milestone — play and stop.
        setActiveMilestone(level);

        if (level >= 10000) {
          // Strongest haptic + confetti burst
          await Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Success,
          ).catch(() => {});
          Animated.timing(confetti, {
            toValue: 1,
            duration: 1600,
            easing: Easing.out(Easing.exp),
            useNativeDriver: true,
          }).start();
        } else if (level >= 1000) {
          // Heavy haptic + ink-ring expansion
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
          Animated.timing(inkRing, {
            toValue: 1,
            duration: 1200,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }).start();
        } else {
          // Medium haptic + sparkle pulse
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
          Animated.sequence([
            Animated.timing(sparkle, {
              toValue: 1,
              duration: 350,
              easing: Easing.out(Easing.quad),
              useNativeDriver: true,
            }),
            Animated.timing(sparkle, {
              toValue: 0.6,
              duration: 150,
              easing: Easing.in(Easing.quad),
              useNativeDriver: true,
            }),
            Animated.timing(sparkle, {
              toValue: 1,
              duration: 300,
              easing: Easing.out(Easing.quad),
              useNativeDriver: true,
            }),
          ]).start();
        }

        break; // one milestone per check
      }
    })().catch(() => {});
  }, [enabled, stampsEarned]);

  function onDismiss() {
    if (activeMilestone !== null) {
      AsyncStorage.setItem(milestoneStorageKey(activeMilestone), 'true').catch(
        () => {},
      );
    }
    setActiveMilestone(null);
    sparkle.setValue(0);
    inkRing.setValue(0);
    confetti.setValue(0);
  }

  return { activeMilestone, sparkle, inkRing, confetti, onDismiss };
}
