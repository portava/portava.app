/**
 * LivePulseCard — the §3 bottom Live Pulse card.
 *
 * Spec §3: "Bottom Live Pulse card summarizes the most important nearby
 * change." One card, not a feed: the map canvas dominates the screen and
 * "cards should not permanently consume half the viewport."
 *
 * The card is the user-facing end of the §26 bridge. Tapping it hands the
 * caller a `MapDeepLinkState` built by `pulseItemToMapState` — the same
 * translation the rest of the app uses — so a Pulse card and the map it opens
 * cannot disagree about what the user just tapped. Which item is "most
 * important" is decided by `selectHeadlinePulseItem`, a pure function in that
 * same module, so the choice is deterministic and testable rather than baked
 * into this component's render.
 *
 * Dark-mode-first per §4: near-black/navy chrome, a rounded translucent card,
 * bright semantic accents, and touch targets at or above 44 px.
 */
import React, { useMemo } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Activity, ChevronRight, ShieldCheck, X } from 'lucide-react-native';
import { color, space, radius, type as t, avatar } from '../../theme/tokens.ts';
import {
  pulseItemToMapState,
  selectHeadlinePulseItem,
} from '../../features/map/pulse/pulseMapBridge.ts';
import type {
  MapDeepLinkState,
  PulseSubjectGeo,
} from '../../features/map/pulse/pulseMapBridge.ts';
import {
  dismissLivePulseItem,
  isLivePulseDismissed,
  isLivePulseDismissible,
} from '../../services/livePulse.ts';
import type { LivePulseItem } from '../../services/livePulse.ts';

// Matches AskCompassBar's chrome so the two floating surfaces read as one system.
const BRAND_BG = '#0A3D4A';
const HAIRLINE = 'rgba(255,255,255,0.14)';
const CHIP_BG = 'rgba(255,255,255,0.13)';

export interface LivePulseCardProps {
  /** Candidate Pulse items; the card picks the single most important one. */
  items: readonly LivePulseItem[];
  /**
   * Geography for the chosen item, resolved by the caller. Without it the deep
   * link still switches mode but does not move the camera — which is the honest
   * behaviour, rather than flying to the user's own dot.
   */
  resolveGeo?: (item: LivePulseItem) => PulseSubjectGeo | null;
  /** Called with the §26 map state for the tapped item. */
  onDeepLink: (state: MapDeepLinkState, item: LivePulseItem) => void;
  /** Called after a dismissible card is dismissed, so the caller can refresh. */
  onDismiss?: (item: LivePulseItem) => void;
  /** Bottom inset so the card clears the safe area / action rail. */
  bottomInset?: number;
}

export function LivePulseCard({
  items,
  resolveGeo,
  onDeepLink,
  onDismiss,
  bottomInset = 0,
}: LivePulseCardProps) {
  const item = useMemo(
    () => selectHeadlinePulseItem(items ?? [], (i) => isLivePulseDismissed(i.id)),
    [items],
  );

  if (!item) return null;

  const isSafety = item.item_type === 'safe_return';
  const dismissible = isLivePulseDismissible(item);
  const reasons = (item.reason_labels ?? []).slice(0, 2);

  const handlePress = () => {
    const geo = resolveGeo?.(item) ?? null;
    onDeepLink(pulseItemToMapState(item, geo), item);
  };

  const handleDismiss = () => {
    dismissLivePulseItem(item.id);
    onDismiss?.(item);
  };

  return (
    <View
      style={[s.wrap, { paddingBottom: Math.max(bottomInset, space.md) }]}
      pointerEvents="box-none"
    >
      <Pressable
        style={[s.card, isSafety && s.cardSafety]}
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityLabel={`${item.status_label}: ${item.title}. Show on map`}
      >
        <View style={s.row}>
          <View style={[s.iconWrap, isSafety && s.iconWrapSafety]}>
            {isSafety ? (
              <ShieldCheck size={16} color="#fff" />
            ) : (
              <Activity size={16} color={color.signal} />
            )}
          </View>

          <View style={s.body}>
            <View style={s.statusRow}>
              <Text style={[s.status, isSafety && s.statusSafety]} numberOfLines={1}>
                {item.status_label.toUpperCase()}
              </Text>
              {item.people_count != null && item.people_count > 0 && (
                <Text style={s.people} numberOfLines={1}>
                  {item.people_count} here
                </Text>
              )}
            </View>

            <Text style={s.title} numberOfLines={1}>
              {item.title}
            </Text>

            {item.subtitle ? (
              <Text style={s.subtitle} numberOfLines={1}>
                {item.subtitle}
              </Text>
            ) : null}

            {reasons.length > 0 && (
              <View style={s.reasonRow}>
                {reasons.map((r) => (
                  <View key={r} style={s.reasonChip}>
                    <Text style={s.reasonText} numberOfLines={1}>
                      {r}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </View>

          <View style={s.tail}>
            {dismissible && (
              <Pressable
                onPress={handleDismiss}
                hitSlop={10}
                style={s.tailBtn}
                accessibilityRole="button"
                accessibilityLabel="Dismiss this update"
              >
                <X size={15} color={color.onInkMute} />
              </Pressable>
            )}
            <View style={s.tailBtn} pointerEvents="none">
              <ChevronRight size={18} color={color.onInkMute} />
            </View>
          </View>
        </View>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    paddingHorizontal: space.md,
  },
  card: {
    backgroundColor: BRAND_BG,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: HAIRLINE,
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 10,
  },
  // §5: safety takes visual precedence over popularity or activity.
  cardSafety: {
    borderColor: color.signal,
    borderWidth: 1.5,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
  },
  iconWrap: {
    width: avatar.s36,
    height: avatar.s36,
    borderRadius: avatar.s36 / 2,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconWrapSafety: {
    backgroundColor: color.signal,
  },
  body: {
    flex: 1,
    gap: 2,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  status: {
    ...t.stamp,
    color: color.signal,
  },
  statusSafety: {
    color: '#fff',
  },
  people: {
    ...t.stamp,
    color: color.onInkMute,
  },
  title: {
    ...t.bodyStrong,
    color: color.onInk,
    fontSize: 15,
  },
  subtitle: {
    ...t.small,
    color: color.onInkMute,
    fontSize: 12,
  },
  reasonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.xs,
    marginTop: space.xs,
  },
  reasonChip: {
    backgroundColor: CHIP_BG,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
  },
  reasonText: {
    ...t.stamp,
    color: color.onInkMute,
    letterSpacing: 0.2,
  },
  tail: {
    flexDirection: 'row',
    alignItems: 'center',
    // Two 44 px targets would overflow a compact card; the row keeps the
    // combined hit area comfortable while hitSlop covers the dismiss control.
    minHeight: 44,
  },
  tailBtn: {
    minWidth: 32,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
