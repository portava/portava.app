/**
 * TelegraphChatCard — compact suggestion card shown in the chat tray.
 * Shows title, reason, category chip, optional location/time context,
 * and action buttons. Fails silently if any press handler throws.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { Zap, MapPin, Clock, X } from 'lucide-react-native';
import { color, space, radius, type as t } from '../theme/tokens';
import type { TelegraphSuggestion } from '../services/telegraphChat';

const CATEGORY_COLORS: Record<string, string> = {
  food: '#F97316',
  nightlife: '#8B5CF6',
  beach: '#0EA5E9',
  attraction: '#10B981',
  transport: '#6B7280',
  meetup: color.signal,
  poll: '#EC4899',
  plan: '#F59E0B',
  availability: '#14B8A6',
  activity: '#6366F1',
};

const ACTION_LABELS: Record<string, string> = {
  add_to_plan: 'Add to Plan',
  create_meetup: 'Create Meetup',
  start_time_poll: 'Start Poll',
  view_place: 'View Ideas',
};

export interface TelegraphChatCardProps {
  suggestion: TelegraphSuggestion;
  onDismiss: (id: string) => void;
  onAction: (suggestion: TelegraphSuggestion) => Promise<void>;
}

export function TelegraphChatCard({
  suggestion,
  onDismiss,
  onAction,
}: TelegraphChatCardProps) {
  const [acting, setActing] = useState(false);

  const chipColor = CATEGORY_COLORS[suggestion.category] ?? CATEGORY_COLORS.activity;
  const actionLabel = ACTION_LABELS[suggestion.action_type] ?? 'View';

  async function handleAction() {
    if (acting) return;
    setActing(true);
    try {
      await onAction(suggestion);
    } catch {
      // silently degrade
    } finally {
      setActing(false);
    }
  }

  return (
    <View style={styles.card}>
      {/* Header row */}
      <View style={styles.headerRow}>
        <View style={styles.zapBadge}>
          <Zap size={10} color={color.onInk} fill={color.onInk} />
        </View>
        <Text style={styles.brandLabel}>Telegraph suggestion</Text>
        <View style={[styles.chip, { backgroundColor: chipColor + '22' }]}>
          <Text style={[styles.chipText, { color: chipColor }]}>
            {suggestion.category}
          </Text>
        </View>
        <Pressable
          style={styles.dismissBtn}
          onPress={() => onDismiss(suggestion.id)}
          hitSlop={8}
        >
          <X size={14} color={color.mute} />
        </Pressable>
      </View>

      {/* Title */}
      <Text style={styles.title} numberOfLines={2}>
        {suggestion.title}
      </Text>

      {/* Reason */}
      <Text style={styles.reason} numberOfLines={2}>
        {suggestion.reason}
      </Text>

      {/* Context row */}
      {(suggestion.location_context || suggestion.time_context) && (
        <View style={styles.contextRow}>
          {suggestion.location_context && (
            <View style={styles.contextItem}>
              <MapPin size={11} color={color.mute} />
              <Text style={styles.contextText} numberOfLines={1}>
                {suggestion.location_context}
              </Text>
            </View>
          )}
          {suggestion.time_context && (
            <View style={styles.contextItem}>
              <Clock size={11} color={color.mute} />
              <Text style={styles.contextText}>{suggestion.time_context}</Text>
            </View>
          )}
        </View>
      )}

      {/* Action button */}
      <Pressable
        style={[styles.actionBtn, acting && { opacity: 0.6 }]}
        onPress={handleAction}
        disabled={acting}
      >
        {acting ? (
          <ActivityIndicator size="small" color={color.onInk} />
        ) : (
          <Text style={styles.actionLabel}>{actionLabel}</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.signal + '33',
    padding: space.md,
    gap: 6,
  },

  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  zapBadge: {
    width: 16,
    height: 16,
    borderRadius: 4,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandLabel: {
    ...t.stamp,
    fontFamily: 'Courier',
    fontSize: 10,
    color: color.signal,
    letterSpacing: 0.3,
    flex: 1,
  },
  chip: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 10,
  },
  chipText: {
    fontSize: 10,
    fontWeight: '600',
    fontFamily: 'Courier',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  dismissBtn: {
    padding: 2,
  },

  title: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 18,
  },
  reason: {
    ...t.small,
    color: color.mute,
    fontSize: 12,
    lineHeight: 16,
  },

  contextRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 2,
  },
  contextItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  contextText: {
    ...t.stamp,
    fontFamily: 'Courier',
    fontSize: 11,
    color: color.mute,
  },

  actionBtn: {
    marginTop: 4,
    backgroundColor: color.signal,
    borderRadius: radius.md,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 34,
  },
  actionLabel: {
    ...t.bodyStrong,
    color: color.onInk,
    fontSize: 13,
    fontWeight: '700',
  },
});
