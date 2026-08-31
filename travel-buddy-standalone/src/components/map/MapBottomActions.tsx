/**
 * MapBottomActions — the persistent action rail (Map spec §3, §25).
 *
 *     "Recommended persistent action rail:
 *      Ask Compass · Meet Here · Add to Trip · Navigate"
 *
 * PERSISTENT MEANS PERSISTENT
 * ===========================
 * All four slots are always rendered, in a fixed order, at a fixed width.
 * Unavailable actions are DISABLED WITH A REASON, never hidden. Hiding them
 * would make the rail reflow every time the selection changed, so the control
 * the user was reaching for would move out from under their thumb — the exact
 * opposite of what "persistent" buys. A disabled slot also answers a question a
 * missing slot cannot: not "where did Navigate go" but "why can't I navigate
 * here". Tapping a disabled slot surfaces that reason inline.
 *
 * DRIVEN BY THE CONTRACT, TIGHTENED BY PRIVACY
 * ============================================
 * Availability comes from the selected object's `interaction.actions`
 * (types/mapObjects.ts) — the projection layer decides what an object affords,
 * the client does not invent it. On top of that the rail applies one local
 * TIGHTENING: an object whose geometry sits at `aggregate_only` or `none` on
 * the §23 privacy ladder cannot offer turn-by-turn navigation or a meeting
 * point, because routing to a deliberately coarsened point implies a precision
 * the object was never given (§19: nothing downstream may sharpen geometry).
 * The tightening can only ever REMOVE an action — it never adds one — so it
 * cannot widen what the server authorized.
 *
 * These are still capability HINTS. Per the contract, "every action
 * re-authorizes on the server when invoked. A client-only gate is not a gate."
 *
 * WIRING
 * ======
 * Presentational and side-effect-free: it emits `onAction(action, selected)`
 * and the map screen routes each slug to its canonical flow (Compass, meeting
 * points, the trip picker, openInMaps). Nothing is implemented twice here.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Compass, Users, CalendarPlus, Navigation } from 'lucide-react-native';
import { color, space, radius, type as t, icon } from '../../theme/tokens.ts';
import {
  precisionRank,
  type MapAction,
  type MapObject,
  type PrivacyClass,
} from '../../types/mapObjects.ts';

// ── The rail (spec §25) ───────────────────────────────────────────────────────

/** The four slots, in the spec's order. Order is part of the contract. */
export const RAIL_ACTIONS: readonly MapAction[] = [
  'ask_compass',
  'meet_here',
  'add_to_trip',
  'navigate',
];

export const RAIL_LABELS: Record<string, string> = {
  ask_compass: 'Ask Compass',
  meet_here: 'Meet Here',
  add_to_trip: 'Add to Trip',
  navigate: 'Navigate',
};

/**
 * What the rail affords with NOTHING selected.
 *
 * Ask Compass and Meet Here are meaningful against the map itself — "what
 * should I do around here", "let's meet at this spot" both make sense without a
 * selected object. Add to Trip and Navigate have no subject until something is
 * selected, so they sit disabled with that as their reason.
 */
export const SELECTIONLESS_RAIL_ACTIONS: readonly MapAction[] = ['ask_compass', 'meet_here'];

/**
 * Actions that route or pin a user to a specific point, and so require geometry
 * at least as precise as `place_level`. See the privacy tightening above.
 */
const PRECISION_REQUIRING_ACTIONS: readonly MapAction[] = ['navigate', 'meet_here'];

const MIN_PRECISION_FOR_ROUTING: PrivacyClass = 'place_level';

/** §25's long-press menu, verbatim and in order. */
export interface MapActionSpec {
  action: MapAction;
  label: string;
}

export const LONG_PRESS_ACTIONS: readonly MapActionSpec[] = [
  { action: 'meet_here', label: 'Meet here' },
  { action: 'save', label: 'Save location' },
  { action: 'add_to_trip', label: 'Add to Trip' },
  { action: 'ask_compass', label: 'Ask Compass about here' },
  { action: 'share', label: 'Share permitted location' },
  { action: 'create_checkpoint', label: 'Create checkpoint' },
  { action: 'report', label: 'Report what is here' },
];

// ── Availability resolution (pure) ────────────────────────────────────────────

export interface RailItem {
  action: MapAction;
  label: string;
  enabled: boolean;
  /** Present exactly when `enabled` is false. Shown on tap, and as a11y hint. */
  reason?: string;
}

function isApproximate(privacyClass: PrivacyClass): boolean {
  return precisionRank(privacyClass) < precisionRank(MIN_PRECISION_FOR_ROUTING);
}

/** The reason a slot is unavailable, phrased for the person holding the phone. */
function reasonFor(action: MapAction, selected: MapObject | null): string {
  if (!selected) {
    return action === 'add_to_trip'
      ? 'Select a place to add it to a trip'
      : 'Select a place on the map first';
  }
  if (PRECISION_REQUIRING_ACTIONS.includes(action) && isApproximate(selected.privacyClass)) {
    return action === 'navigate'
      ? 'This location is approximate — no directions'
      : 'This area is approximate — pick an exact spot';
  }
  switch (action) {
    case 'navigate':
      return 'No directions available here';
    case 'meet_here':
      return 'Meeting points are not available here';
    case 'add_to_trip':
      return 'This cannot be added to a trip';
    case 'ask_compass':
      return 'Compass has nothing to add here';
    default:
      return 'Not available here';
  }
}

/**
 * Resolve the four rail slots for the current selection.
 *
 * Pure — no React, no I/O — so the availability rules can be reasoned about and
 * tested independently of rendering. ALWAYS returns exactly RAIL_ACTIONS.length
 * items in RAIL_ACTIONS order, which is what keeps the rail from reflowing.
 */
export function resolveRailActions(selected: MapObject | null | undefined): RailItem[] {
  const target = selected ?? null;
  const afforded: readonly MapAction[] = target
    ? (target.interaction?.actions ?? [])
    : SELECTIONLESS_RAIL_ACTIONS;

  return RAIL_ACTIONS.map((action) => {
    let enabled = afforded.includes(action);

    // Privacy tightening — subtractive only.
    if (
      enabled &&
      target &&
      PRECISION_REQUIRING_ACTIONS.includes(action) &&
      isApproximate(target.privacyClass)
    ) {
      enabled = false;
    }

    return enabled
      ? { action, label: RAIL_LABELS[action] ?? action, enabled: true }
      : { action, label: RAIL_LABELS[action] ?? action, enabled: false, reason: reasonFor(action, target) };
  });
}

// ── Component ─────────────────────────────────────────────────────────────────

const RAIL_ICONS: Record<string, React.ComponentType<{ size?: number; color?: string }>> = {
  ask_compass: Compass,
  meet_here: Users,
  add_to_trip: CalendarPlus,
  navigate: Navigation,
};

/** How long an explanation for a disabled slot stays on screen. */
const REASON_VISIBLE_MS = 3000;

export interface MapBottomActionsProps {
  /** The currently selected map object, or null for the selection-less rail. */
  selected?: MapObject | null;
  /** Invoked for an ENABLED slot. The screen routes the slug to its own flow. */
  onAction: (action: MapAction, selected: MapObject | null) => void;
  /**
   * Optional hook for a disabled tap. When omitted the rail explains itself
   * inline, which is the intended default — the reason belongs next to the
   * control, not in an alert the user has to dismiss.
   */
  onUnavailable?: (action: MapAction, reason: string) => void;
  /** Bottom safe-area inset, forwarded by the map screen. */
  bottomInset?: number;
}

export function MapBottomActions({
  selected = null,
  onAction,
  onUnavailable,
  bottomInset = 0,
}: MapBottomActionsProps) {
  const items = resolveRailActions(selected);
  const [reason, setReason] = useState<string | null>(null);

  // Clear a stale explanation when the selection changes underneath it.
  useEffect(() => {
    setReason(null);
  }, [selected?.id]);

  useEffect(() => {
    if (!reason) return;
    const id = setTimeout(() => setReason(null), REASON_VISIBLE_MS);
    return () => clearTimeout(id);
  }, [reason]);

  const handlePress = useCallback(
    (item: RailItem) => {
      if (item.enabled) {
        setReason(null);
        onAction(item.action, selected);
        return;
      }
      const why = item.reason ?? 'Not available here';
      if (onUnavailable) onUnavailable(item.action, why);
      else setReason(why);
    },
    [onAction, onUnavailable, selected],
  );

  return (
    <View
      style={[s.wrap, { paddingBottom: Math.max(bottomInset, space.md) }]}
      pointerEvents="box-none"
      testID="map-bottom-actions"
    >
      {reason ? (
        <View style={s.reasonPill} testID="map-bottom-actions-reason">
          <Text style={s.reasonText} numberOfLines={2}>
            {reason}
          </Text>
        </View>
      ) : null}

      <View style={s.rail}>
        {items.map((item) => {
          const Icon = RAIL_ICONS[item.action] ?? Compass;
          return (
            <Pressable
              key={item.action}
              testID={`map-rail-${item.action}`}
              onPress={() => handlePress(item)}
              style={({ pressed }) => [s.slot, pressed && s.slotPressed]}
              accessibilityRole="button"
              accessibilityLabel={item.label}
              // The slot stays tappable so a disabled action can explain itself;
              // `disabled` in the a11y state is what assistive tech announces.
              accessibilityState={{ disabled: !item.enabled }}
              accessibilityHint={item.enabled ? undefined : item.reason}
            >
              <View style={!item.enabled && s.dim}>
                <Icon size={icon.s18} color={item.enabled ? ON_DARK : ON_DARK_FAINT} />
              </View>
              <Text
                style={[s.slotLabel, !item.enabled && s.slotLabelDisabled]}
                numberOfLines={1}
              >
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

// Dark map chrome (§4), matching AskCompassBar's bottom-anchored treatment.
const RAIL_BG = color.deep;
const RAIL_BORDER = 'rgba(255,255,255,0.14)';
const ON_DARK = color.onInk;
const ON_DARK_FAINT = 'rgba(250,249,246,0.42)';

const s = StyleSheet.create({
  wrap: {
    paddingHorizontal: space.md,
    gap: space.sm,
  },
  reasonPill: {
    alignSelf: 'center',
    maxWidth: '100%',
    backgroundColor: 'rgba(17,17,15,0.92)',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: RAIL_BORDER,
    paddingHorizontal: space.md,
    paddingVertical: 8,
  },
  reasonText: {
    ...t.small,
    fontSize: 12,
    color: ON_DARK,
    textAlign: 'center',
  },
  rail: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: RAIL_BG,
    borderRadius: radius.lg,
    paddingVertical: 6,
    paddingHorizontal: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 8,
  },
  slot: {
    // Equal flex on every slot: the rail's geometry does not depend on which
    // actions happen to be available, so nothing moves when the selection changes.
    flex: 1,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingHorizontal: 2,
    borderRadius: radius.md,
  },
  slotPressed: {
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  dim: {
    opacity: 0.55,
  },
  slotLabel: {
    ...t.small,
    fontSize: 11,
    fontWeight: '700',
    color: ON_DARK,
    textAlign: 'center',
  },
  slotLabelDisabled: {
    color: ON_DARK_FAINT,
    fontWeight: '600',
  },
});
