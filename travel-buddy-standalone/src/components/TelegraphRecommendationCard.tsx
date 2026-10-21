/**
 * TelegraphRecommendationCard — AI activity recommendation rendered inside
 * a Telegraph thread as an ai_activity_recommendation message.
 *
 * Shows: title, category badge, reason, location context, estimated time,
 * price level, and two action buttons (Add to Trip / Dismiss).
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Zap, MapPin, Clock, DollarSign, X, CalendarPlus, Bookmark, ThumbsDown } from 'lucide-react-native';
import { PortavaShareIcon } from './icons/PortavaShareIcon.tsx';
import type { TelegraphActivityRecommendation } from '../types/models.ts';
import { space, radius, type as t } from '../theme/tokens.ts';
import { useTelegraphTheme, type TelegraphPalette, type TelegraphScheme } from '../features/telegraph/theme/telegraphTheme.ts';
import { RichText } from './RichText.tsx';

// census T123: a category hue is the card's edge, its badge tint AND its badge
// text, so each scheme has its own — '#333' text on the dark card was unreadable.
const CATEGORY_COLOR: Readonly<Record<TelegraphScheme, Record<string, string>>> = {
  light: {
    food:      '#C8851A',
    nightlife: '#7A4DBF',
    beach:     '#0A7DBF',
    activity:  '#2E7D5B',
    hotel:     '#C0392B',
    transport: '#888888',
    tip:       '#555555',
    default:   '#333333',
  },
  dark: {
    food:      '#E0A040',
    nightlife: '#B08BE8',
    beach:     '#4FB3E8',
    activity:  '#5DBB8F',
    hotel:     '#E8705F',
    transport: '#A0A0A0',
    tip:       '#B8B8B8',
    default:   '#CCCCCC',
  },
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
  onSave?: (rec: TelegraphActivityRecommendation) => void;
  onShare?: (rec: TelegraphActivityRecommendation) => void;
  onNotInterested?: (rec: TelegraphActivityRecommendation) => void;
}

export function TelegraphRecommendationCard({ rec, onAddToTrip, onDismiss, onSave, onShare, onNotInterested }: Props) {
  const { palette, styles } = useTelegraphTheme(makeStyles);
  const hues = CATEGORY_COLOR[palette.scheme];
  const accent = hues[rec.category] ?? hues.default;

  return (
    <View style={[styles.card, { borderLeftColor: accent }]}>
      {/* Header row */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={[styles.zapRow]}>
            <Zap size={11} color={palette.operational} />
            <Text style={styles.telegraphLabel}>TELEGRAPH</Text>
          </View>
          <Text style={styles.title} numberOfLines={2}>{rec.title}</Text>
        </View>
        {onDismiss && (
          <Pressable style={styles.dismissBtn} onPress={() => onDismiss(rec.id)} hitSlop={8}>
            <X size={14} color={palette.mute} />
          </Pressable>
        )}
      </View>

      {/* Category badge */}
      <View style={[styles.badge, { backgroundColor: accent + '22' }]}>
        <Text style={[styles.badgeText, { color: accent }]}>{rec.category.toUpperCase()}</Text>
      </View>

      {/* Reason — RichText renders tappable @mention and #hashtag spans when present */}
      <RichText
        content={rec.reason}
        tags={rec.tagSpans}
        hashtagUsages={rec.hashtagSpans}
        mentionColor={palette.operational}
        hashtagColor={palette.operational}
        style={styles.reason}
      />

      {/* Meta row */}
      <View style={styles.meta}>
        {rec.locationContext ? (
          <View style={styles.metaItem}>
            <MapPin size={11} color={palette.mute} />
            <Text style={styles.metaText} numberOfLines={1}>{rec.locationContext}</Text>
          </View>
        ) : null}
        {rec.estimatedTime ? (
          <View style={styles.metaItem}>
            <Clock size={11} color={palette.mute} />
            <Text style={styles.metaText}>{rec.estimatedTime}</Text>
          </View>
        ) : null}
        {rec.priceLevel ? (
          <View style={styles.metaItem}>
            <DollarSign size={11} color={palette.mute} />
            <Text style={styles.metaText}>{PRICE_LABEL[rec.priceLevel] ?? rec.priceLevel}</Text>
          </View>
        ) : null}
      </View>

      {/* Actions */}
      {(onAddToTrip || onSave || onShare || onNotInterested) && (
        <View style={styles.actions}>
          {onAddToTrip && (
            <Pressable style={styles.addBtn} onPress={() => onAddToTrip(rec)}>
              <CalendarPlus size={13} color={palette.operationalOn} />
              <Text style={styles.addBtnText}>Add to Trip</Text>
            </Pressable>
          )}
          {onSave && (
            <Pressable style={styles.iconBtn} onPress={() => onSave(rec)} hitSlop={8}>
              <Bookmark size={15} color={palette.operational} />
            </Pressable>
          )}
          {onShare && (
            <Pressable
              style={styles.iconBtn}
              onPress={() => onShare(rec)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Share this recommendation"
            >
              <PortavaShareIcon size={15} color={palette.mute} />
            </Pressable>
          )}
          {onNotInterested && (
            <Pressable style={styles.iconBtn} onPress={() => onNotInterested(rec)} hitSlop={8}>
              <ThumbsDown size={15} color={palette.mute} />
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

// census T123/T124: the scheme's colours; the Telegraph mark, Save and Add to
// Trip are ordinary actions, so they are the operational teal, not vermilion.
const makeStyles = (p: TelegraphPalette) => StyleSheet.create({
  card: {
    backgroundColor: p.surfaceRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: p.recvBorder,
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
    color: p.operational,
    letterSpacing: 1,
  },
  title: {
    ...t.bodyStrong,
    color: p.recvText,
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
    color: p.mute,
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
    color: p.mute,
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
    backgroundColor: p.operational,
    borderRadius: radius.pill,
    paddingVertical: 7,
    paddingHorizontal: space.md,
  },
  addBtnText: {
    ...t.small,
    color: p.operationalOn,
    fontWeight: '700',
    fontSize: 12,
  },
  iconBtn: {
    width: 30,
    height: 30,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: p.recvBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
