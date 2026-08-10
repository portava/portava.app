/**
 * LivePulseCard — renders one item from the Live Pulse smart rail.
 *
 * Displays: status badge, object-type label, title, subtitle, people count,
 * reason labels, and up to two action buttons.
 * Dismissible cards show an "×" button.
 */
import React, { useCallback, useState } from 'react';
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
import {
  isLivePulseDismissible,
  type LivePulseItem,
  type LivePulseItemType,
} from '../services/livePulse.ts';
import { rsvpEvent, saveEvent, unsaveEvent } from '../services/events.ts';
import { saveGem } from '../services/hiddenGems.ts';
import { useRankOutcome } from '../hooks/useRankOutcome.ts';

interface LivePulseCardProps {
  item: LivePulseItem;
  /**
   * Serve session for the Live Pulse batch this card came from (from
   * useLivePulse). Sent with every outcome this card reports so the outcome
   * route matches THIS rail's impression row rather than the most recent
   * surface='live_pulse' impression for the same entity — which matters when
   * the same event or trip has been served by several Live Pulse loads.
   *
   * This is precision, NOT the safety mechanism. Cross-surface hijacking is
   * prevented by Live Pulse owning surface='live_pulse', a key space the ranked
   * /pulse feed never writes into; that holds whether or not a session is sent.
   * Null when the server returned no session, in which case the outcome still
   * lands on the correct surface, just on whichever live_pulse impression is
   * most recent.
   */
  sessionId?: string | null;
  onDismiss?: (id: string) => void;
  onActionDone?: () => void;
}

/**
 * Live Pulse item types whose rank_events serve row is keyed by the SAME id
 * this card carries in `item.item_id`, and is therefore reportable from here.
 *
 * Mirrors LIVE_PULSE_ITEM_KIND in the API's src/lib/rankLog.ts. Two categories
 * are absent on purpose:
 *
 *   circle / safe_return / compass / buddy_request — the server emits no serve
 *     row at all for these, so an outcome would find nothing to attribute to.
 *
 *   available_buddy — the server DOES emit a row, but keyed by the buddy's
 *     user_id (matching the ranked /pulse writer), whereas this card holds
 *     rent_buddy_profiles.id. The response carries no user_id, so an outcome
 *     posted from here could only reference the wrong namespace. Reporting
 *     nothing is a gap; reporting the profile id would be wrong data.
 *
 * `item.id` — the composite `${item_type}:${item_id}` presentation key — is
 * never used for reporting; only the canonical `item.item_id` is.
 */
const OUTCOME_REPORTABLE_TYPES: ReadonlySet<LivePulseItemType> = new Set<LivePulseItemType>([
  'event',
  'trip',
  'trip_request',
  'hidden_gem',
]);

/** Outcomes this card can produce, from the rank_events outcome vocabulary. */
type CardOutcome = 'save' | 'rsvp';

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

/**
 * @param onOutcome Reports a completed conversion for this card. Called only
 *   after the underlying API call actually succeeded — an outcome row that
 *   claims a save the server rejected is worse than no row. Navigation actions
 *   report nothing: the destination screens report against surface 'events'
 *   (useEventRsvp) and a Live Pulse session belongs to surface 'live_pulse', so
 *   carrying it across would break the lookup rather than sharpen it — the
 *   session would be filtered against a surface that never wrote it.
 */
async function handleAction(
  type: string,
  item: LivePulseItem,
  onDone?: () => void,
  onOutcome?: (outcome: CardOutcome) => void,
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
      router.push({ pathname: '/(rent-a-buddy)/checkout', params: { buddyId: item.item_id } } as any);
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
    case 'rsvp_event_going': {
      // Only 'going' is a commitment, and only a successful one converts —
      // same rule useEventRsvp applies on the event screen.
      const res = await rsvpEvent(item.item_id, 'going').catch(() => null);
      if (res?.ok) onOutcome?.('rsvp');
      onDone?.();
      break;
    }
    case 'share_event':
      router.push(`/event/${item.item_id}` as any);
      break;

    // ── Trip actions ──────────────────────────────────────────────────────────
    case 'invite_to_trip':
      router.push(`/trip/${item.item_id}` as any);
      break;

    // ── Event save/unsave ─────────────────────────────────────────────────────
    case 'save_event': {
      const res = await saveEvent(item.item_id).catch(() => null);
      if (res?.ok) onOutcome?.('save');
      onDone?.();
      break;
    }
    case 'unsave_event':
      // No outcome: rank_events has no "unsave" value, and downgrading an
      // already-recorded save is not something the outcome route supports.
      await unsaveEvent(item.item_id).catch(() => null);
      onDone?.();
      break;

    // ── Gem / Compass actions ─────────────────────────────────────────────────
    case 'save_gem': {
      // saveGem rejects on failure and reports `alreadySaved` when the gem was
      // in the user's saves before this card was served. Only a fresh save is
      // a conversion of this impression — matching SaveButton, which fires
      // only on the transition into the saved state.
      const res = await saveGem(item.item_id).catch(() => null);
      if (res && !res.alreadySaved) onOutcome?.('save');
      onDone?.();
      break;
    }

    default:
      break;
  }
}

export function LivePulseCard({ item, sessionId, onDismiss, onActionDone }: LivePulseCardProps) {
  const [primaryLoading, setPrimaryLoading] = useState(false);

  const badge = BADGE_STYLES[item.status_label] ?? BADGE_STYLES['My Plan'];
  const typeLabel = TYPE_LABELS[item.item_type] ?? item.item_type;
  const dismissible = isLivePulseDismissible(item);

  // surface 'live_pulse' — the Live Pulse serve rows are written with
  // surface='live_pulse', so an outcome must use the same surface to match
  // them. This is a SEPARATE key space from the ranked /pulse feed, and that
  // separation is the mechanism that stops a Live Pulse outcome from landing on
  // a ranked pulse impression for the same entity: the outcome lookup filters
  // on surface, so the two can never collide regardless of what else is sent.
  //
  // sessionId is precision on top of that, not the mechanism. It narrows the
  // lookup to THIS serve batch when the same entity appeared in more than one
  // Live Pulse load; when it is null the lookup falls back to the most recent
  // live_pulse impression for this (user, item), which is still the right
  // surface. Do not reintroduce a dependency on it being present.
  const { reportSave, reportRsvp } = useRankOutcome({
    surface: 'live_pulse',
    sessionId: sessionId ?? null,
  });

  const reportOutcome = useCallback(
    (outcome: CardOutcome) => {
      if (!OUTCOME_REPORTABLE_TYPES.has(item.item_type)) return;
      if (outcome === 'save') reportSave(item.item_id);
      else reportRsvp(item.item_id);
    },
    [item.item_type, item.item_id, reportSave, reportRsvp],
  );

  async function onPrimary() {
    if (!item.primary_action) return;
    setPrimaryLoading(true);
    await handleAction(item.primary_action.type, item, onActionDone, reportOutcome);
    setPrimaryLoading(false);
  }

  async function onSecondary() {
    if (!item.secondary_action) return;
    await handleAction(item.secondary_action.type, item, onActionDone, reportOutcome);
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
