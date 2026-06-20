/**
 * TelegraphRecommendationCard — AI activity recommendation rendered inside
 * a Telegraph thread as an ai_activity_recommendation message.
 *
 * Shows: title, category badge, reason, location context, estimated time,
 * price level, and two action buttons (Add to Trip / Dismiss).
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Zap, MapPin, Clock, DollarSign, X, CalendarPlus } from 'lucide-react-native';
import type { TelegraphActivityRecommendation } from '../types/models';
import { color, space, radius, type as t } from '../theme/tokens';

const CATEGORY_COLOR: Record<string, string> = {
  food:      '#C8851A',
  nightlife: '#7A4DBF',
  beach:     '#0A7DBF',
  activity:  '#2E7D5B',
  hotel:     '#C0392B',
  transport: '#888',
  tip:       '#555',
  default:   '#333',
};

const PRICE_LABEL: Record<string, string> = {
  free: 'Free',
  '$':  '$',
  '$$': '$$',
  '$$$': '$$$',
  '$$$$': '$$$$',
};

interface Props {
  rec: TelegraphActivityRecommendation;
  onAddToTrip?: (rec: TelegraphActivityRecommendation) => void;
  onDismiss?: (recId: string) => void;
}

export function TelegraphRecommendationCard({ rec, onAddToTrip, onDismiss }: Props) {
  const accent = CATEGORY_COLOR[rec.category] ?? CATEGORY_COLOR.default;

  return (
    <View style={[styles.card, { borderLeftColor: accent }]}>
      {/* Header row */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={[styles.zapRow]}>
            <Zap size={11} color={color.signal} />
            <Text style={styles.telegraphLabel}>TELEGRAPH</Text>
          </View>
          <Text style={styles.title} numberOfLines={2}>{rec.title}</Text>
        </View>
        {onDismiss && (
          <Pressable style={styles.dismissBtn} onPress={() => onDismiss(rec.id)} hitSlop={8}>
            <X size={14} color={color.mute} />
          </Pressable>
        )}
      </View>

      {/* Category badge */}
      <View style={[styles.badge, { backgroundColor: accent + '22' }]}>
        <Text style={[styles.badgeText, { color: accent }]}>{rec.category.toUpperCase()}</Text>
      </View>

      {/* Reason */}
      <Text style={styles.reason}>{rec.reason}</Text>

      {/* Meta row */}
      <View style={styles.meta}>
        {rec.locationContext ? (
          <View style={styles.metaItem}>
            <MapPin size={11} color={color.mute} />
            <Text style={styles.metaText} numberOfLines={1}>{rec.locationContext}</Text>
          </View>
        ) : null}
        {rec.estimatedTime ? (
          <View style={styles.metaItem}>
            <Clock size={11} color={color.mute} />
            <Text style={styles.metaText}>{rec.estimatedTime}</Text>
          </View>
        ) : null}
        {rec.priceLevel ? (
          <View style={styles.metaItem}>
            <DollarSign size={11} color={color.mute} />
            <Text style={styles.metaText}>{PRICE_LABEL[rec.priceLevel] ?? rec.priceLevel}</Text>
          </View>
        ) : null}
      </View>

      {/* Actions */}
      {onAddToTrip && (
        <View style={styles.actions}>
          <Pressable style={styles.addBtn} onPress={() => onAddToTrip(rec)}>
            <CalendarPlus size={14} color={color.onInk} />
            <Text style={styles.addBtnText}>Add to Trip</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    borderLeftWidth: 3,
    padding: space.lg,
    gap: space.sm,
    maxWidth: '90%',
    alignSelf: 'flex-start',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
  },
  headerLeft: { flex: 1, gap: 3 },
  zapRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  telegraphLabel: {
    fontSize: 9,
    fontFamily: 'Courier',
    fontWeight: '700',
    color: color.signal,
    letterSpacing: 1,
  },
  title: {
    ...t.bodyStrong,
    color: color.ink,
    lineHeight: 20,
  },
  dismissBtn: {
    padding: 2,
    marginTop: 2,
  },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  badgeText: {
    fontSize: 10,
    fontFamily: 'Courier',
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  reason: {
    ...t.small,
    color: color.mute,
    lineHeight: 18,
  },
  meta: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.md,
    marginTop: 2,
  },
  metaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  metaText: {
    ...t.small,
    color: color.mute,
    fontSize: 11,
  },
  actions: {
    marginTop: space.sm,
    flexDirection: 'row',
    gap: space.sm,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    backgroundColor: color.signal,
    borderRadius: radius.pill,
    paddingVertical: 7,
    paddingHorizontal: space.md,
  },
  addBtnText: {
    ...t.small,
    color: color.onInk,
    fontWeight: '700',
    fontSize: 12,
  },
});
