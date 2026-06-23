/**
 * TelegraphSuggestionTray — collapsible tray above the chat composer.
 *
 * - Fetches suggestions on mount and whenever a new message is sent.
 * - Loads cached suggestions from AsyncStorage on mount so they survive restarts.
 * - Shows a subtle "From earlier" label while serving cached suggestions.
 * - Renders 1–2 TelegraphChatCard components.
 * - Shows nothing when list is empty (no spinner, no error banner).
 * - Fails silently if the API errors.
 */
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Clock } from 'lucide-react-native';
import { color, space, type as t, icon } from '../theme/tokens';
import { TelegraphChatCard } from './TelegraphChatCard';
import {
  getTelegraphSuggestions,
  dismissSuggestion,
  addSuggestionToPlan,
  getSuggestionMeetupPrefill,
  startTimePoll,
  type TelegraphSuggestion,
} from '../services/telegraphChat';

const MAX_CACHED = 10;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
  suggestions: TelegraphSuggestion[];
  savedAt: number;
}

function cacheKey(threadId: string) {
  return `telegraph_suggestions_${threadId}`;
}

async function readCache(
  threadId: string,
  tripEndDate?: string | null,
): Promise<TelegraphSuggestion[] | null> {
  try {
    const raw = await AsyncStorage.getItem(cacheKey(threadId));
    if (!raw) return null;
    const entry: CacheEntry = JSON.parse(raw);
    const age = Date.now() - entry.savedAt;
    if (age > CACHE_TTL_MS) {
      AsyncStorage.removeItem(cacheKey(threadId)).catch(() => {});
      return null;
    }
    if (tripEndDate) {
      const endMs = new Date(tripEndDate).getTime();
      if (!Number.isNaN(endMs) && Date.now() > endMs) {
        AsyncStorage.removeItem(cacheKey(threadId)).catch(() => {});
        return null;
      }
    }
    return entry.suggestions.length > 0 ? entry.suggestions : null;
  } catch {
    return null;
  }
}

async function writeCache(
  threadId: string,
  suggestions: TelegraphSuggestion[],
): Promise<void> {
  try {
    const entry: CacheEntry = {
      suggestions: suggestions.slice(0, MAX_CACHED),
      savedAt: Date.now(),
    };
    await AsyncStorage.setItem(cacheKey(threadId), JSON.stringify(entry));
  } catch {
    // silent
  }
}

async function clearCache(threadId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(cacheKey(threadId));
  } catch {
    // silent
  }
}

export interface TelegraphSuggestionTrayProps {
  threadId: string;
  /** Pass the last sent message body so intent detection runs server-side. */
  lastSentMessage?: string;
  /**
   * Optional trip end date (ISO string). If today is past this date the cached
   * suggestions are discarded on load.
   */
  tripEndDate?: string | null;
  /** Called when user taps "Add to Plan" — receives suggestion + needs tripId from caller. */
  onAddToPlan?: (suggestion: TelegraphSuggestion) => Promise<string | null>;
  /** Called when user taps "Create Meetup" — receives prefill data. */
  onCreateMeetup?: (prefill: import('../services/telegraphChat').MeetupPrefill) => void;
  /** Called when user taps "View Ideas" / "View Place" */
  onViewPlace?: (suggestion: TelegraphSuggestion) => void;
}

export function TelegraphSuggestionTray({
  threadId,
  lastSentMessage,
  tripEndDate,
  onAddToPlan,
  onCreateMeetup,
  onViewPlace,
}: TelegraphSuggestionTrayProps) {
  const [suggestions, setSuggestions] = useState<TelegraphSuggestion[]>([]);
  const [stale, setStale] = useState(false);
  const prevMessage = useRef<string | undefined>(undefined);
  const opacity = useRef(new Animated.Value(0)).current;
  const hasFreshLoad = useRef(false);

  const showTray = useCallback(
    (cards: TelegraphSuggestion[]) => {
      setSuggestions(cards);
      if (cards.length > 0) {
        Animated.timing(opacity, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }).start();
      } else {
        opacity.setValue(0);
      }
    },
    [opacity],
  );

  const load = useCallback(
    async (msgText?: string) => {
      try {
        const cards = await getTelegraphSuggestions(threadId, msgText);
        hasFreshLoad.current = true;
        setStale(false);
        showTray(cards);
        if (cards.length > 0) {
          await writeCache(threadId, cards);
        } else {
          await clearCache(threadId);
        }
      } catch {
        // silent fail — keep showing cached data if present
      }
    },
    [threadId, showTray],
  );

  // On mount: load cache immediately, then fetch fresh in background
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cached = await readCache(threadId, tripEndDate);
      if (!cancelled && cached && !hasFreshLoad.current) {
        setStale(true);
        showTray(cached);
      }
    })();
    load();
    return () => {
      cancelled = true;
    };
  }, [load, threadId, tripEndDate, showTray]);

  // Reload when a new message is sent
  useEffect(() => {
    if (lastSentMessage && lastSentMessage !== prevMessage.current) {
      prevMessage.current = lastSentMessage;
      load(lastSentMessage);
    }
  }, [lastSentMessage, load]);

  async function handleDismiss(id: string) {
    const next = suggestions.filter((s) => s.id !== id);
    setSuggestions(next);
    if (next.length > 0) {
      await writeCache(threadId, next).catch(() => {});
    } else {
      await clearCache(threadId).catch(() => {});
    }
    await dismissSuggestion(threadId, id).catch(() => {});
  }

  async function handleAction(suggestion: TelegraphSuggestion) {
    switch (suggestion.action_type) {
      case 'add_to_plan': {
        if (onAddToPlan) {
          const tripId = await onAddToPlan(suggestion);
          if (tripId) {
            await addSuggestionToPlan(threadId, suggestion.id, tripId, {
              title: suggestion.title,
            }).catch(() => {});
            const next = suggestions.filter((s) => s.id !== suggestion.id);
            setSuggestions(next);
            if (next.length > 0) {
              await writeCache(threadId, next).catch(() => {});
            } else {
              await clearCache(threadId).catch(() => {});
            }
          }
        }
        break;
      }
      case 'create_meetup': {
        const prefill = await getSuggestionMeetupPrefill(threadId, suggestion.id).catch(() => null);
        if (prefill && onCreateMeetup) {
          onCreateMeetup(prefill);
          const next = suggestions.filter((s) => s.id !== suggestion.id);
          setSuggestions(next);
          if (next.length > 0) {
            await writeCache(threadId, next).catch(() => {});
          } else {
            await clearCache(threadId).catch(() => {});
          }
        }
        break;
      }
      case 'start_time_poll': {
        await startTimePoll(threadId, suggestion.id).catch(() => {});
        const next = suggestions.filter((s) => s.id !== suggestion.id);
        setSuggestions(next);
        if (next.length > 0) {
          await writeCache(threadId, next).catch(() => {});
        } else {
          await clearCache(threadId).catch(() => {});
        }
        break;
      }
      case 'view_place':
      default: {
        if (onViewPlace) {
          onViewPlace(suggestion);
        }
        const next = suggestions.filter((s) => s.id !== suggestion.id);
        setSuggestions(next);
        if (next.length > 0) {
          await writeCache(threadId, next).catch(() => {});
        } else {
          await clearCache(threadId).catch(() => {});
        }
        break;
      }
    }
  }

  if (suggestions.length === 0) return null;

  return (
    <Animated.View style={[styles.tray, { opacity }]}>
      {stale && (
        <View style={styles.staleRow}>
          <Clock size={icon.sm} color={color.faint} />
          <Text style={styles.staleLabel}>From earlier</Text>
        </View>
      )}
      {suggestions.map((s) => (
        <TelegraphChatCard
          key={s.id}
          suggestion={s}
          onDismiss={handleDismiss}
          onAction={handleAction}
        />
      ))}
    </Animated.View>
  );
}

/** Removes any cached suggestions for the given thread (call on thread delete). */
export function clearTelegraphSuggestionsCache(threadId: string): Promise<void> {
  return clearCache(threadId);
}

const styles = StyleSheet.create({
  tray: {
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: 4,
    gap: space.sm,
    borderTopWidth: 1,
    borderTopColor: color.signal + '22',
    backgroundColor: color.paper,
  },
  staleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    marginBottom: -space.xs,
  },
  staleLabel: {
    ...t.stamp,
    color: color.faint,
    textTransform: 'uppercase',
  },
});
