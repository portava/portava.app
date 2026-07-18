/**
 * PulseLiveCarousel — hero-section live-event flasher for the Pulse screen.
 *
 * Shows one ongoing event at a time (auto-advancing every 4 s), with a
 * smooth crossfade between cards and dot indicators when > 1 event is live.
 * Swipe left/right to navigate manually.  Auto-advance pauses while the user
 * is touching.  Respects reduceMotion: instant fade, no auto-advance.
 *
 * When 0 events are ongoing, a single static fallback line is rendered.
 * "Ongoing" = startAt <= now < startAt + DEFAULT_DURATION (2-hour proxy).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  PanResponder,
  StyleSheet,
  AccessibilityInfo,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  useReducedMotion,
} from 'react-native-reanimated';
import { router, useFocusEffect } from 'expo-router';
import type { CityEvent } from '../types/models.ts';
import { pv } from '../theme/pulseTheme.ts';
import { type as t } from '../theme/tokens.ts';

// ── Constants ────────────────────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;
/** Matches DEFAULT_DURATION in PulseLiveBanner — no schema endsAt field. */
export const DEFAULT_DURATION = 2 * HOUR;

const AUTO_ADVANCE_MS = 4000;
const SWIPE_THRESHOLD = 40; // pt
const FADE_DURATION = 300;   // ms

// ── Time helper ─────────────────────────────────────────────────────────────

function formatRemaining(endsAt: number, now: number): string {
  const ms = endsAt - now;
  if (ms <= 0) return '0m';
  const totalMins = Math.floor(ms / 60000);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

// ── Props ────────────────────────────────────────────────────────────────────

export interface PulseLiveCarouselProps {
  events: CityEvent[];
  /** Injectable for tests — defaults to Date.now(). */
  now?: number;
}

// ── Component ────────────────────────────────────────────────────────────────

export function PulseLiveCarousel({ events, now: nowProp }: PulseLiveCarouselProps) {
  const now = nowProp ?? Date.now();
  const reduceMotion = useReducedMotion();

  // Filter to ongoing events only
  const ongoingEvents = events.filter((ev) => {
    const s = new Date(ev.startAt).getTime();
    if (Number.isNaN(s)) return false;
    return s <= now && now < s + DEFAULT_DURATION;
  });

  if (ongoingEvents.length === 0) {
    return (
      <Text style={styles.fallback} numberOfLines={1} accessibilityLabel="Nothing live nearby right now">
        Nothing live nearby right now
      </Text>
    );
  }

  return (
    <CarouselInner
      ongoingEvents={ongoingEvents}
      now={now}
      reduceMotion={reduceMotion ?? false}
    />
  );
}

// ── Inner component (only rendered when ≥1 event) ────────────────────────────

function CarouselInner({
  ongoingEvents,
  now,
  reduceMotion,
}: {
  ongoingEvents: CityEvent[];
  now: number;
  reduceMotion: boolean;
}) {
  const count = ongoingEvents.length;
  const [activeIndex, setActiveIndex] = useState(0);
  const opacity = useSharedValue(1);
  const touching = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Crossfade then switch card
  const switchTo = useCallback(
    (nextIndex: number) => {
      if (reduceMotion) {
        setActiveIndex(nextIndex);
        return;
      }
      opacity.value = withTiming(0, { duration: FADE_DURATION / 2 }, (done) => {
        if (done) {
          // Update index in the worklet completion — setActiveIndex is fine here
          // because it's called from the JS thread via 'runOnJS' pattern below.
        }
      });
      // JS-side: after half the duration, swap index, then fade back in
      setTimeout(() => {
        setActiveIndex(nextIndex);
        opacity.value = withTiming(1, { duration: FADE_DURATION / 2 });
      }, FADE_DURATION / 2);
    },
    [opacity, reduceMotion],
  );

  // Start / restart the auto-advance interval
  const startInterval = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (reduceMotion || count <= 1) return;
    intervalRef.current = setInterval(() => {
      if (!touching.current) {
        setActiveIndex((prev) => {
          const next = (prev + 1) % count;
          // trigger fade
          if (!reduceMotion) {
            opacity.value = 0;
            setTimeout(() => {
              opacity.value = withTiming(1, { duration: FADE_DURATION / 2 });
            }, 0);
          }
          return next;
        });
      }
    }, AUTO_ADVANCE_MS);
  }, [count, reduceMotion, opacity]);

  // Pause auto-advance when the screen loses focus; restart (and reset to the
  // first card) when it regains focus.  This also handles app backgrounding
  // because Expo Router fires the blur callback when the app goes to background.
  useFocusEffect(
    useCallback(() => {
      setActiveIndex(0);
      startInterval();
      return () => {
        if (intervalRef.current) clearInterval(intervalRef.current);
      };
    }, [startInterval]),
  );

  // Swipe gesture — only activate on clear horizontal movement so the inner
  // Pressable still receives taps. NOT claiming responder on touchStart avoids
  // the common "swipe wrapper swallows tap" problem in React Native.
  const panResponder = useRef(
    PanResponder.create({
      // Let touch fall through to child Pressable on initial contact.
      onStartShouldSetPanResponder: () => false,
      // Claim responder only when the gesture is clearly horizontal and has
      // moved past the activation threshold.
      onMoveShouldSetPanResponder: (_, gs) =>
        Math.abs(gs.dx) > Math.abs(gs.dy) && Math.abs(gs.dx) > 8,
      onPanResponderGrant: () => {
        touching.current = true;
      },
      onPanResponderRelease: (_, gs) => {
        touching.current = false;
        if (Math.abs(gs.dx) >= SWIPE_THRESHOLD) {
          setActiveIndex((prev) => {
            const next =
              gs.dx < 0
                ? (prev + 1) % count
                : (prev - 1 + count) % count;
            return next;
          });
          opacity.value = 1;
        }
      },
      onPanResponderTerminate: () => {
        touching.current = false;
      },
    }),
  ).current;

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: reduceMotion ? 1 : opacity.value,
  }));

  const ev = ongoingEvents[activeIndex];
  if (!ev) return null;

  const startMs = new Date(ev.startAt).getTime();
  const endsAt = startMs + DEFAULT_DURATION;
  const timeRemaining = formatRemaining(endsAt, now);
  const accessLabel = `${ev.title} — LIVE, ends in ${timeRemaining}`;

  return (
    <View style={styles.carouselWrap} {...panResponder.panHandlers}>
      <Animated.View style={[styles.cardOuter, animatedStyle]}>
        <Pressable
          style={styles.card}
          onPress={() => router.push(`/event/${ev.id}` as any)}
          accessibilityRole="button"
          accessibilityLabel={accessLabel}
        >
          {/* Left: badge + title + category */}
          <View style={styles.cardLeft}>
            <View style={styles.liveBadge}>
              <View style={styles.liveDot} />
              <Text style={styles.liveText}>LIVE</Text>
            </View>
            <Text style={styles.eventTitle} numberOfLines={2}>{ev.title}</Text>
            <Text style={styles.categoryText} numberOfLines={1}>{ev.category}</Text>
          </View>

          {/* Right: ends-in + attendees */}
          <View style={styles.cardRight}>
            <Text style={styles.endsIn}>Ends in</Text>
            <Text style={styles.endsTime}>{timeRemaining}</Text>
            {ev.attendeeCount != null && (
              <Text style={styles.attendees}>{ev.attendeeCount} going</Text>
            )}
          </View>
        </Pressable>
      </Animated.View>

      {/* Dot indicators — only when > 1 event */}
      {count > 1 && (
        <View style={styles.dots}>
          {ongoingEvents.map((_, i) => (
            <Pressable
              key={i}
              onPress={() => switchTo(i)}
              accessibilityRole="button"
              accessibilityLabel={`Go to event ${i + 1}`}
              hitSlop={8}
              style={[styles.dot, i === activeIndex && styles.dotActive]}
            />
          ))}
        </View>
      )}
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  fallback: {
    ...t.small,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 2,
    color: pv.textMute,
  },
  carouselWrap: {
    marginTop: 2,
  },
  cardOuter: {
    // opacity driven by Reanimated
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: pv.navySoft,
    borderWidth: 1,
    borderColor: pv.navyEdge,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 10,
  },
  cardLeft: {
    flex: 1,
    gap: 2,
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: pv.coral,
  },
  liveText: {
    fontSize: 9,
    lineHeight: 12,
    fontWeight: '800',
    letterSpacing: 1.5,
    color: pv.coral,
    fontFamily: 'Courier',
  },
  eventTitle: {
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '700',
    color: pv.text,
    flexShrink: 1,
  },
  categoryText: {
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '600',
    color: pv.textMute,
    textTransform: 'capitalize',
  },
  cardRight: {
    alignItems: 'flex-end',
    gap: 2,
    flexShrink: 0,
  },
  endsIn: {
    fontSize: 9,
    lineHeight: 11,
    color: pv.textFaint,
    fontWeight: '600',
  },
  endsTime: {
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '700',
    color: pv.text,
  },
  attendees: {
    fontSize: 10,
    lineHeight: 13,
    color: pv.textMute,
    fontWeight: '500',
  },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 5,
    marginTop: 6,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: pv.navyEdge,
  },
  dotActive: {
    backgroundColor: pv.coral,
  },
});
