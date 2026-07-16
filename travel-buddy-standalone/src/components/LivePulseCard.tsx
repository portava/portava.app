/**
 * LivePulseCard — renders one item from the Live Pulse smart rail.
 *
 * Displays: status badge, object-type label, title, subtitle, people count,
 * reason labels, and up to two action buttons.
 * Dismissible cards show an "×" button.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { router } from 'expo-router';
import { Users, X } from 'lucide-react-native';
import { color, space, type as t } from '../theme/tokens.ts';
import { isLivePulseDismissible, type LivePulseItem } from '../services/livePulse.ts';
import { rsvpEvent, saveEvent, unsaveEvent } from '../services/events.ts';
import { saveGem } from '../services/hiddenGems.ts';

interface LivePulseCardProps {
  item: LivePulseItem;
  onDismiss?: (id: string) => void;
  onActionDone?: () => void;
}

// ── Status badge colours ───────────────────────────────────────────────────────

const BADGE_STYLES: Record<string, { bg: string; text: string }> = {
  'Starting Soon': { bg: '#FFF3E0', text: '#E65100' },
  'Ongoing':       { bg: '#E8F5E9', text: '#2E7D32' },
  'Ends Soon':     { bg: '#FCE4EC', text: '#AD1457' },
  'Tonight':       { bg: '#EDE7F6', text: '#4527A0' },
  'Tomorrow':      { bg: '#E3F2FD', text: '#1565C0' },
  'Upcoming':      { bg: '#F3F4F6', text: '#374151' },
  'Action Needed': { bg: '#FFEBEE', text: '#B71C1C' },
  'My Plan':       { bg: '#F3F4F6', text: '#6B7280' },
};

const TYPE_LABELS: Record<string, string> = {
  event:           'Event',
  trip:            'Trip',
  buddy_request:   'Buddy',
  available_buddy: 'Meet a Buddy',
  hidden_gem:      'Hidden Gem',
  compass:         'Compass',
  circle:          'Circle',
  safe_return:     'Safety',
};

// ── Action handler ─────────────────────────────────────────────────────────────

async function handleAction(
  type: string,
  item: LivePulseItem,
  onDone?: () => void,
): Promise<void> {
  switch (type) {
    // ── Navigation ───────────────────────────────────────────────────────────
    // Route paths match actual Expo Router file structure:
    //   app/event/[id].tsx, app/trip/[id].tsx, app/gems/[id].tsx,
    //   app/(rent-a-buddy)/booking/[id].tsx, app/(rent-a-buddy)/buddy/[id].tsx
    //   app/circle.tsx  (no ID in path — context passed as query param)
    //   app/settings/safety.tsx (Safe Return landing)
    case 'navigate_event':
      router.push(`/event/${item.item_id}` as any);
      break;
    case 'navigate_trip':
      router.push(`/trip/${item.item_id}` as any);
      break;
    case 'navigate_buddy_booking':
      router.push(`/(rent-a-buddy)/booking/${item.item_id}` as any);
      break;
    case 'navigate_buddy_profile':
      router.push(`/(rent-a-buddy)/buddy/${item.item_id}` as any);
      break;
    case 'request_buddy':
      // item_id is the buddy profile ID; request-buddy screen initiates the booking flow
      router.push({ pathname: '/(rent-a-buddy)/request-buddy', params: { buddyId: item.item_id } } as any);
      break;
    case 'navigate_gem':
      router.push(`/gems/${item.item_id}` as any);
      break;
    case 'navigate_circle':
      // Circle lives in /circle; pass trip context as query param
      router.push({ pathname: '/circle', params: { contextType: 'trip', contextId: item.item_id } } as any);
      break;

    // ── Safe Return — routes to /settings/safety (the safety hub screen) ─────
    case 'confirm_safe_return':
    case 'extend_safe_return':
      router.push('/profile/edit/safety' as any);
      break;

    // ── Buddy booking actions ─────────────────────────────────────────────────
    case 'cancel_buddy_booking':
    case 'decline_buddy_booking':
      router.push(`/(rent-a-buddy)/booking/${item.item_id}` as any);
      break;

    // ── Event actions ─────────────────────────────────────────────────────────
    case 'rsvp_event_going':
      await rsvpEvent(item.item_id, 'going').catch(() => null);
      onDone?.();
      break;
    case 'share_event':
      router.push(`/event/${item.item_id}` as any);
      break;

    // ── Trip actions ──────────────────────────────────────────────────────────
    case 'invite_to_trip':
      router.push(`/trip/${item.item_id}` as any);
      break;

    // ── Event save/unsave ─────────────────────────────────────────────────────
    case 'save_event':
      await saveEvent(item.item_id).catch(() => null);
      onDone?.();
      break;
    case 'unsave_event':
      await unsaveEvent(item.item_id).catch(() => null);
      onDone?.();
      break;

    // ── Gem / Compass actions ─────────────────────────────────────────────────
    case 'save_gem':
      await saveGem(item.item_id).catch(() => null);
      onDone?.();
      break;

    default:
      break;
  }
}

export function LivePulseCard({ item, onDismiss, onActionDone }: LivePulseCardProps) {
  const [primaryLoading, setPrimaryLoading] = useState(false);

  const badge = BADGE_STYLES[item.status_label] ?? BADGE_STYLES['My Plan'];
  const typeLabel = TYPE_LABELS[item.item_type] ?? item.item_type;
  const dismissible = isLivePulseDismissible(item);

  async function onPrimary() {
    if (!item.primary_action) return;
    setPrimaryLoading(true);
    await handleAction(item.primary_action.type, item, onActionDone);
    setPrimaryLoading(false);
  }

  async function onSecondary() {
    if (!item.secondary_action) return;
    await handleAction(item.secondary_action.type, item, onActionDone);
  }

  return (
    <TouchableOpacity
      style={styles.card}
      onPress={onPrimary}
      activeOpacity={0.85}
    >
      {/* Dismiss button */}
      {dismissible && onDismiss && (
        <TouchableOpacity
          style={styles.dismissBtn}
          onPress={() => onDismiss(item.id)}
          hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
        >
          <X size={12} color={color.mute} />
        </TouchableOpacity>
      )}

      {/* Header row: type label + status badge */}
      <View style={styles.headerRow}>
        <Text style={styles.typeLabel}>{typeLabel.toUpperCase()}</Text>
        <View style={[styles.badge, { backgroundColor: badge.bg }]}>
          <Text style={[styles.badgeText, { color: badge.text }]}>{item.status_label}</Text>
        </View>
      </View>

      {/* Title */}
      <Text style={styles.title} numberOfLines={2}>{item.title}</Text>

      {/* Subtitle */}
      {item.subtitle ? (
        <Text style={styles.subtitle} numberOfLines={1}>{item.subtitle}</Text>
      ) : null}

      {/* People count */}
      {item.people_count != null && item.people_count > 0 ? (
        <View style={styles.peopleRow}>
          <Users size={12} color={color.mute} />
          <Text style={styles.peopleText}>{item.people_count}</Text>
        </View>
      ) : null}

      {/* Reason labels */}
      {item.reason_labels.length > 0 ? (
        <View style={styles.reasonRow}>
          {item.reason_labels.map((label) => (
            <View key={label} style={styles.reasonChip}>
              <Text style={styles.reasonText}>{label}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {/* Actions */}
      {(item.primary_action || item.secondary_action) ? (
        <View style={styles.actionsRow}>
          {item.primary_action ? (
            <TouchableOpacity style={styles.primaryBtn} onPress={onPrimary}>
              {primaryLoading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.primaryBtnText}>{item.primary_action.label}</Text>
              )}
            </TouchableOpacity>
          ) : null}
          {item.secondary_action ? (
            <TouchableOpacity style={styles.secondaryBtn} onPress={onSecondary}>
              <Text style={styles.secondaryBtnText}>{item.secondary_action.label}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    width: 200,
    backgroundColor: color.paper,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    gap: space.xs,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  dismissBtn: {
    position: 'absolute',
    top: space.sm,
    right: space.sm,
    zIndex: 1,
    padding: 2,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    flexWrap: 'wrap',
  },
  typeLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: color.faint,
    letterSpacing: 1.2,
  },
  badge: {
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '700',
  },
  title: {
    ...t.bodyStrong,
    fontSize: 14,
    color: color.ink,
    lineHeight: 19,
    marginTop: 2,
  },
  subtitle: {
    ...t.small,
    fontSize: 12,
    color: color.mute,
  },
  peopleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  peopleText: {
    ...t.small,
    fontSize: 11,
    color: color.mute,
  },
  reasonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 4,
  },
  reasonChip: {
    backgroundColor: color.paperRaised,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  reasonText: {
    fontSize: 10,
    color: color.deep,
    fontWeight: '500',
  },
  actionsRow: {
    flexDirection: 'row',
    gap: space.xs,
    marginTop: space.sm,
  },
  primaryBtn: {
    flex: 1,
    backgroundColor: color.signal,
    borderRadius: 8,
    paddingVertical: 7,
    alignItems: 'center',
  },
  primaryBtnText: {
    ...t.small,
    fontSize: 12,
    fontWeight: '700',
    color: '#fff',
  },
  secondaryBtn: {
    flex: 1,
    backgroundColor: color.paperRaised,
    borderRadius: 8,
    paddingVertical: 7,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: color.haze,
  },
  secondaryBtnText: {
    ...t.small,
    fontSize: 12,
    fontWeight: '600',
    color: color.ink,
  },
});
