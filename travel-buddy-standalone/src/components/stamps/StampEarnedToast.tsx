/**
 * StampEarnedToast — bottom-slide celebration toast shown when
 * a new stamp has been earned. Deduplicates seen stamp IDs via
 * AsyncStorage so the toast only fires once per stamp per device.
 *
 * Wrap your root layout in <StampEarnedToastProvider> to activate it.
 * Trigger checks via checkForNewStamps() after stamp-awarding actions
 * (trip creation, safe-return completion, etc.).
 */
import React, {
  createContext, useContext, useCallback, useEffect, useRef, useState,
} from 'react';
import {
  View, Text, Pressable, StyleSheet, Animated, Platform, AccessibilityInfo,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { Award, X } from 'lucide-react-native';
import { getMyRecentStamps } from '../../services/stamps.ts';
import type { PassportStampNew } from '../../services/passportStamps.ts';
import { color, space, radius, type as t, avatar } from '../../theme/tokens.ts';

const SEEN_KEY = 'stamp_earned_seen_ids';
/** Only surface stamps earned within this window of the triggering action. */
const RECENT_WINDOW_MS = 30_000;

const SOURCE_LABELS: Record<string, string> = {
  trip:        'Completed a trip',
  plan:        'Joined a travel plan',
  host:        'Hosted an experience',
  safe_return: 'Completed a safe meetup',
  hidden_gem:  'Discovered a hidden gem',
  check_in:    'GPS-verified check-in',
  system:      'Awarded by Portava',
  manual:      'Manually awarded',
  event:       'Attended an event',
  rent_buddy:  'Rent a Buddy activity',
};

import { RARITY_COLORS, RARITY_LABEL, normalizeRarity } from '../../lib/stampRarity.ts';

async function getSeenIds(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(SEEN_KEY);
    return raw ? new Set<string>(JSON.parse(raw)) : new Set<string>();
  } catch {
    return new Set<string>();
  }
}

async function markSeen(id: string): Promise<void> {
  try {
    const seen = await getSeenIds();
    seen.add(id);
    await AsyncStorage.setItem(SEEN_KEY, JSON.stringify([...seen]));
  } catch {}
}

interface ToastCtx {
  showStampToast: (stamp: PassportStampNew) => void;
  /**
   * Poll /stamps/me immediately and surface any newly earned stamps as toasts.
   * Pass delayMs (default 2000) to wait before polling — useful right after a
   * server action that awards stamps, giving the server time to finish.
   */
  checkForNewStamps: (delayMs?: number) => void;
}

const StampToastContext = createContext<ToastCtx>({
  showStampToast: () => {},
  checkForNewStamps: () => {},
});

export function useStampToast() {
  return useContext(StampToastContext);
}

export function StampEarnedToastProvider({ children }: { children: React.ReactNode }) {
  const [queue, setQueue] = useState<PassportStampNew[]>([]);
  const [current, setCurrent] = useState<PassportStampNew | null>(null);
  const slideAnim = useRef(new Animated.Value(120)).current;
  const timerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Respect the OS "reduce motion" setting: skip the slide spring/timing and
  // snap in/out instead (consistent with StampCard's shimmer gate).
  const reduceMotion = useRef(false);
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then((v) => { reduceMotion.current = v; });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => { reduceMotion.current = v; });
    return () => sub.remove();
  }, []);

  // Show from queue
  useEffect(() => {
    if (current || queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    setCurrent(next);
    if (reduceMotion.current) {
      slideAnim.setValue(0); // snap in — no motion
    } else {
      Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, bounciness: 6 }).start();
    }
    timerRef.current = setTimeout(dismiss, 4000);
  }, [current, queue]);

  function dismiss() {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (reduceMotion.current) {
      setCurrent(null);
      slideAnim.setValue(120); // snap out — no motion
      return;
    }
    Animated.timing(slideAnim, { toValue: 120, duration: 250, useNativeDriver: true }).start(() => {
      setCurrent(null);
      slideAnim.setValue(120);
    });
  }

  function handleView() {
    dismiss();
    if (current?.id) {
      router.push(`/stamp/${current.id}` as any);
    } else {
      router.push('/(tabs)/passport?tab=stamps' as any);
    }
  }

  const showStampToast = useCallback((stamp: PassportStampNew) => {
    setQueue((q) => [...q, stamp]);
  }, []);

  const checkForNewStamps = useCallback((delayMs = 2000) => {
    // Capture the action timestamp BEFORE the delay so recency is measured from
    // when the triggering action occurred, not when the poll fires.
    const triggeredAt = Date.now();
    const run = async () => {
      const res = await getMyRecentStamps().catch(() => null);
      if (!res?.ok) return;
      const seen = await getSeenIds();
      for (const stamp of res.data) {
        if (seen.has(stamp.id)) continue;
        // Always mark as seen to prevent stale awards surfacing in future checks.
        await markSeen(stamp.id);
        // Only show a toast if the stamp was earned within ~30s of the action.
        const earnedMs = stamp.earnedAt ? new Date(stamp.earnedAt).getTime() : 0;
        if (triggeredAt - earnedMs <= RECENT_WINDOW_MS) {
          showStampToast(stamp);
        }
      }
    };
    if (delayMs > 0) {
      setTimeout(run, delayMs);
    } else {
      run();
    }
  }, [showStampToast]);

  // Seed seen IDs on first load so existing stamps don't fire toasts on mount.
  // No background interval — stamp checks run only after explicit triggering actions.
  useEffect(() => {
    let alive = true;
    getMyRecentStamps()
      .then(async (res) => {
        if (!res.ok || !alive) return;
        const seen = await getSeenIds();
        for (const stamp of res.data) seen.add(stamp.id);
        await AsyncStorage.setItem(SEEN_KEY, JSON.stringify([...seen]));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const stampName = current
    ? (current.titleOverride ?? current.definition?.name ?? current.city ?? 'New stamp')
    : '';
  const reason = current
    ? (SOURCE_LABELS[current.sourceType] ?? current.sourceType.replace(/_/g, ' '))
    : '';
  const rarity = current?.definition?.rarity ? normalizeRarity(current.definition.rarity) : null;
  const rarityLabel = rarity ? RARITY_LABEL[rarity] : null;
  const rarityColor = rarity ? RARITY_COLORS[rarity].ring : RARITY_COLORS.common.ring;

  const subText = [rarityLabel, stampName, reason ? `— ${reason}` : '']
    .filter(Boolean)
    .join(' · ')
    .replace(' · —', ' —');

  return (
    <StampToastContext.Provider value={{ showStampToast, checkForNewStamps }}>
      {children}

      {current && (
        <Animated.View
          style={[styles.toast, { transform: [{ translateY: slideAnim }] }]}
          pointerEvents="box-none"
        >
          <View style={styles.inner}>
            <View style={[styles.iconWrap, { backgroundColor: rarityColor }]}>
              <Award size={20} color="#fff" />
            </View>

            <View style={styles.textWrap}>
              <Text style={styles.title}>Passport Stamp Earned 🌍</Text>
              <Text style={styles.sub} numberOfLines={1}>
                {subText}
              </Text>
            </View>

            <Pressable onPress={handleView} hitSlop={8} style={styles.viewBtn}>
              <Text style={styles.viewBtnText}>View Passport</Text>
            </Pressable>

            <Pressable onPress={dismiss} hitSlop={8} style={styles.closeBtn}>
              <X size={14} color={color.mute} />
            </Pressable>
          </View>
        </Animated.View>
      )}
    </StampToastContext.Provider>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: 'absolute',
    bottom: Platform.OS === 'ios' ? 90 : 72,
    left: space.lg,
    right: space.lg,
    zIndex: 9999,
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#111110',
    borderRadius: radius.lg,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    gap: space.sm,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  iconWrap: {
    width: avatar.md, height: avatar.md,
    borderRadius: avatar.md / 2,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  textWrap: { flex: 1, minWidth: 0 },
  title:    { ...t.bodyStrong, color: '#fff', fontSize: 13 },
  sub:      { ...t.small, color: '#9CA3AF', marginTop: 1 },
  viewBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.sm,
    backgroundColor: color.signal,
    flexShrink: 0,
  },
  viewBtnText: { ...t.small, color: '#fff', fontWeight: '700' },
  closeBtn: { padding: 4, flexShrink: 0 },
});
