/**
 * TelegraphSuggestionTray — collapsible tray above the chat composer.
 *
 * - Fetches suggestions on mount and whenever a new message is sent.
 * - Renders 1–2 TelegraphChatCard components.
 * - Shows nothing when list is empty (no spinner, no error banner).
 * - Fails silently if the API errors.
 */
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { View, StyleSheet, Animated } from 'react-native';
import { color, space } from '../theme/tokens';
import { TelegraphChatCard } from './TelegraphChatCard';
import {
  getTelegraphSuggestions,
  dismissSuggestion,
  addSuggestionToPlan,
  getSuggestionMeetupPrefill,
  startTimePoll,
  type TelegraphSuggestion,
} from '../services/telegraphChat';

export interface TelegraphSuggestionTrayProps {
  threadId: string;
  /** Pass the last sent message body so intent detection runs server-side. */
  lastSentMessage?: string;
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
  onAddToPlan,
  onCreateMeetup,
  onViewPlace,
}: TelegraphSuggestionTrayProps) {
  const [suggestions, setSuggestions] = useState<TelegraphSuggestion[]>([]);
  const prevMessage = useRef<string | undefined>(undefined);
  const opacity = useRef(new Animated.Value(0)).current;

  const load = useCallback(
    async (msgText?: string) => {
      try {
        const cards = await getTelegraphSuggestions(threadId, msgText);
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
      } catch {
        // silent fail
      }
    },
    [threadId, opacity],
  );

  // Initial load
  useEffect(() => {
    load();
  }, [load]);

  // Reload when a new message is sent
  useEffect(() => {
    if (lastSentMessage && lastSentMessage !== prevMessage.current) {
      prevMessage.current = lastSentMessage;
      load(lastSentMessage);
    }
  }, [lastSentMessage, load]);

  async function handleDismiss(id: string) {
    setSuggestions((prev) => prev.filter((s) => s.id !== id));
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
            setSuggestions((prev) => prev.filter((s) => s.id !== suggestion.id));
          }
        }
        break;
      }
      case 'create_meetup': {
        const prefill = await getSuggestionMeetupPrefill(threadId, suggestion.id).catch(() => null);
        if (prefill && onCreateMeetup) {
          onCreateMeetup(prefill);
          setSuggestions((prev) => prev.filter((s) => s.id !== suggestion.id));
        }
        break;
      }
      case 'start_time_poll': {
        await startTimePoll(threadId, suggestion.id).catch(() => {});
        setSuggestions((prev) => prev.filter((s) => s.id !== suggestion.id));
        break;
      }
      case 'view_place':
      default: {
        if (onViewPlace) {
          onViewPlace(suggestion);
        }
        setSuggestions((prev) => prev.filter((s) => s.id !== suggestion.id));
        break;
      }
    }
  }

  if (suggestions.length === 0) return null;

  return (
    <Animated.View style={[styles.tray, { opacity }]}>
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
});
