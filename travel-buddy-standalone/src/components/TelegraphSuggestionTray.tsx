/**
 * TelegraphSuggestionTray — collapsible tray above the chat composer.
 *
 * - Fetches suggestions on mount and whenever a new message is sent.
 * - Loads cached suggestions from AsyncStorage on mount so they survive restarts.
 * - Shows a subtle "From earlier" label while serving cached suggestions.
 * - Renders 1–2 TelegraphChatCard components.
 * - When 3+ suggestions span 2+ categories, shows dynamic filter chips so the
 *   user can narrow the tray in-place (category facet; OR within the facet).
 * - Shows nothing when list is empty (no spinner, no error banner).
 * - Fails silently if the API errors.
 */
import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { View, Text, StyleSheet, Animated, ScrollView, Pressable } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Clock } from 'lucide-react-native';
import { color, space, radius, type as t, icon } from '../theme/tokens.ts';
import { TelegraphChatCard } from './TelegraphChatCard.tsx';
import {
  getTelegraphSuggestions,
  dismissSuggestion,
  addSuggestionToPlan,
  getSuggestionMeetupPrefill,
  startTimePoll,
  type TelegraphSuggestion,
} from '../services/telegraphChat.ts';

const MAX_CACHED = 10;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Show the filter chip row only once there are enough cards to be worth narrowing. */
const MIN_SUGGESTIONS_FOR_FILTERS = 3;

/** Display labels for the category facet (suggestions only carry a raw `category`). */
const CATEGORY_LABELS: Record<string, string> = {
  food: 'Food',
  nightlife: 'Nightlife',
  beach: 'Beach',
  attraction: 'Attraction',
  transport: 'Transport',
  meetup: 'Meetup',
  poll: 'Time Poll',
  plan: 'Plan',
  availability: 'Availability',
  activity: 'Activity',
};

function labelFor(category: string): string {
  return (
    CATEGORY_LABELS[category] ??
    category.charAt(0).toUpperCase() + category.slice(1)
  );
}

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
  onCreateMeetup?: (prefill: import('../services/telegraphChat.ts').MeetupPrefill) => void;
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
  const [activeFilters, setActiveFilters] = useState<string[]>([]);
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

  // Distinct categories present in the current suggestions, in first-seen order.
  const categories = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of suggestions) {
      if (!seen.has(s.category)) {
        seen.add(s.category);
        out.push(s.category);
      }
    }
    return out;
  }, [suggestions]);

  // Drop any active filter whose category is no longer present after a reload.
  useEffect(() => {
    setActiveFilters((prev) => {
      const next = prev.filter((c) => categories.includes(c));
      return next.length === prev.length ? prev : next;
    });
  }, [categories]);

  // OR within the single category facet: a card matches if no filter is active
  // or its category is one of the selected ones.
  const visible = useMemo(() => {
    if (activeFilters.length === 0) return suggestions;
    const set = new Set(activeFilters);
    return suggestions.filter((s) => set.has(s.category));
  }, [suggestions, activeFilters]);

  const showFilters =
    categories.length >= 2 && suggestions.length >= MIN_SUGGESTIONS_FOR_FILTERS;
  const filtersActive = activeFilters.length > 0;

  function toggleFilter(category: string) {
    setActiveFilters((prev) =>
      prev.includes(category)
        ? prev.filter((c) => c !== category)
        : [...prev, category],
    );
  }

  function clearFilters() {
    setActiveFilters([]);
  }

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
      {showFilters && (
        <View style={styles.filterSection}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.filterScroll}
            contentContainerStyle={styles.filterRow}
          >
            {categories.map((c) => {
              const active = activeFilters.includes(c);
              return (
                <Pressable
                  key={c}
                  onPress={() => toggleFilter(c)}
                  hitSlop={6}
                  style={[styles.chip, active ? styles.chipActive : styles.chipIdle]}
                >
                  <Text
                    style={[
                      styles.chipText,
                      active ? styles.chipTextActive : styles.chipTextIdle,
                    ]}
                  >
                    {labelFor(c)}
                  </Text>
                </Pressable>
              );
            })}
            {filtersActive && (
              <Pressable
                onPress={clearFilters}
                hitSlop={6}
                style={[styles.chip, styles.chipClear]}
              >
                <Text style={[styles.chipText, styles.chipClearText]}>Clear</Text>
              </Pressable>
            )}
          </ScrollView>
          {filtersActive && (
            <Text style={styles.countBadge}>
              {visible.length} of {suggestions.length}
            </Text>
          )}
        </View>
      )}
      {visible.map((s) => (
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
  filterSection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  filterScroll: {
    flex: 1,
  },
  filterRow: {
    gap: space.xs,
    alignItems: 'center',
    paddingRight: space.xs,
  },
  chip: {
    paddingHorizontal: space.sm,
    paddingVertical: 5,
    borderRadius: radius.sm,
    borderWidth: 1,
  },
  chipIdle: {
    backgroundColor: 'transparent',
    borderColor: color.haze,
  },
  chipActive: {
    backgroundColor: color.signal,
    borderColor: color.signal,
  },
  chipClear: {
    backgroundColor: 'transparent',
    borderColor: 'transparent',
    paddingHorizontal: space.xs,
  },
  chipText: {
    ...t.small,
    fontWeight: '600',
  },
  chipTextIdle: {
    color: color.mute,
  },
  chipTextActive: {
    color: color.onInk,
  },
  chipClearText: {
    color: color.signal,
    fontWeight: '700',
  },
  countBadge: {
    ...t.stamp,
    color: color.faint,
  },
});
