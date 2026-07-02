/**
 * StampEarnedToast — bottom-slide celebration toast shown when
 * a new stamp has been earned. Polls /stamps/recent every 30 s
 * and deduplicates seen stamp IDs via AsyncStorage so the toast
 * only fires once per stamp per device.
 *
 * Wrap your root layout in <StampEarnedToastProvider> to activate it.
 */
import React, {
  createContext, useContext, useCallback, useEffect, useRef, useState,
} from 'react';
import {
  View, Text, Pressable, StyleSheet, Animated, Platform,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { Award, X } from 'lucide-react-native';
import { getMyRecentStamps } from '../../services/stamps';
import type { PassportStampNew } from '../../services/passportStamps';
import { color, space, radius, type as t } from '../../theme/tokens';

const SEEN_KEY = 'stamp_earned_seen_ids';
const POLL_MS  = 30_000;

const SOURCE_LABELS: Record<string, string> = {
  trip:        'Completed a trip',
  plan:        'Joined a travel plan',
  host:        'Hosted an experience',
  safe_return: 'Completed a safe meetup',
  hidden_gem:  'Discovered a hidden gem',
  check_in:    'GPS-verified check-in',
  system:      'Awarded by Travel Buddy',
  manual:      'Manually awarded',
  event:       'Attended an event',
  rent_buddy:  'Rent a Buddy activity',
};

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
}

const StampToastContext = createContext<ToastCtx>({ showStampToast: () => {} });

export function useStampToast() {
  return useContext(StampToastContext);
}

export function StampEarnedToastProvider({ children }: { children: React.ReactNode }) {
  const [queue, setQueue] = useState<PassportStampNew[]>([]);
  const [current, setCurrent] = useState<PassportStampNew | null>(null);
  const slideAnim = useRef(new Animated.Value(120)).current;
  const timerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Show from queue
  useEffect(() => {
    if (current || queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    setCurrent(next);
    Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, bounciness: 6 }).start();
    timerRef.current = setTimeout(dismiss, 4000);
  }, [current, queue]);

  function dismiss() {
    if (timerRef.current) clearTimeout(timerRef.current);
    Animated.timing(slideAnim, { toValue: 120, duration: 250, useNativeDriver: true }).start(() => {
      setCurrent(null);
      slideAnim.setValue(120);
    });
  }

  function handleView() {
    dismiss();
    router.push('/(tabs)/passport?tab=stamps' as any);
  }

  const showStampToast = useCallback((stamp: PassportStampNew) => {
    setQueue((q) => [...q, stamp]);
  }, []);

  // Poll /stamps/recent
  useEffect(() => {
    let alive = true;

    async function poll() {
      const res = await getMyRecentStamps().catch(() => null);
      if (!res?.ok || !alive) return;

      const seen = await getSeenIds();
      for (const stamp of res.data) {
        if (!seen.has(stamp.id)) {
          await markSeen(stamp.id);
          showStampToast(stamp);
        }
      }
    }

    // Seed seen IDs on first load (mark existing stamps as seen without showing toasts)
    getMyRecentStamps()
      .then(async (res) => {
        if (!res.ok || !alive) return;
        const seen = await getSeenIds();
        for (const stamp of res.data) seen.add(stamp.id);
        await AsyncStorage.setItem(SEEN_KEY, JSON.stringify([...seen]));
      })
      .catch(() => {});

    const id = setInterval(poll, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [showStampToast]);

  const stampName = current
    ? (current.titleOverride ?? current.definition?.name ?? current.city ?? 'New stamp')
    : '';
  const reason = current
    ? (SOURCE_LABELS[current.sourceType] ?? current.sourceType.replace(/_/g, ' '))
    : '';

  return (
    <StampToastContext.Provider value={{ showStampToast }}>
      {children}

      {current && (
        <Animated.View
          style={[styles.toast, { transform: [{ translateY: slideAnim }] }]}
          pointerEvents="box-none"
        >
          <View style={styles.inner}>
            <View style={styles.iconWrap}>
              <Award size={20} color="#fff" />
            </View>

            <View style={styles.textWrap}>
              <Text style={styles.title}>Passport Stamp Earned 🌍</Text>
              <Text style={styles.sub} numberOfLines={1}>
                {stampName}{reason ? ` — ${reason}` : ''}
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
    width: 36,
    height: 36,
    borderRadius: 18,
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
