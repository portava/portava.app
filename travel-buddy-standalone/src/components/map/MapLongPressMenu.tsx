/**
 * MapLongPressMenu — the §25 long-press context menu.
 *
 *     "Long-press actions:
 *      Meet here. Save location. Add to Trip. Ask Compass about here.
 *      Share permitted location. Create checkpoint. Report what is here."
 *
 * WHAT THIS IS
 * ============
 * A dismissible menu anchored to the point the user pressed. It renders exactly
 * what `features/map/interaction/longPress.ts` resolved and nothing else: no
 * availability logic, no privacy decision, no I/O, no navigation. Selecting an
 * entry emits `onSelect(action, target)` and the map screen routes the slug to
 * its canonical flow — the same division of labour as `MapBottomActions`.
 *
 * IT ACTS ON A POINT, NOT ON A SELECTION
 * ======================================
 * Unlike the rail, this menu is frequently opened on EMPTY MAP: "Meet here" and
 * "Create checkpoint" are mostly pressed on a spot with no object. `target` is
 * therefore a `LongPressTarget` — either an object or a bare coordinate — and
 * the header line comes from `describeTarget`, which coarsens a coordinate and
 * refuses to name anyone at a §23 rung that forbids identity.
 *
 * NOTHING IS HIDDEN, AND THE HEIGHT IS FIXED
 * ==========================================
 * All seven rows always render, in §25's order, at a fixed row height, so the
 * menu is the same size and shape for every press. An unavailable row is dimmed
 * and states its reason on its second line instead of vanishing — the reason
 * belongs next to the control, and a menu that changed height per press would
 * move the row the user was reaching for.
 *
 * The second line of the SHARE row is the §37 bound the share would open with
 * ("Place-level · expires in 60 min"). That is not decoration: §37 forbids
 * permanent exact-location sharing, so the menu says out loud how coarse and
 * how short-lived the share is BEFORE the user taps it.
 *
 * LABELS
 * ======
 * The §25 wording lives once, in `MapBottomActions.LONG_PRESS_ACTIONS`. This
 * file reads it rather than restating it, and iterates it directly so the
 * rendered order is that list's order.
 */
import React, { useCallback, useMemo } from 'react';
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import {
  Bookmark,
  CalendarPlus,
  Compass,
  Flag,
  Milestone,
  Share2,
  Users,
} from 'lucide-react-native';

import { color, icon, radius, space, type as t } from '../../theme/tokens.ts';
import type { MapAction } from '../../types/mapObjects.ts';
import {
  describeTarget,
  longPressItemFor,
  resolveLongPressActions,
  type LongPressContext,
  type LongPressItem,
  type LongPressShareBound,
  type LongPressTarget,
} from '../../features/map/interaction/longPress.ts';
import { LONG_PRESS_ACTIONS } from './MapBottomActions.tsx';

// ── Geometry ──────────────────────────────────────────────────────────────────

const MENU_WIDTH = 252;
/** Two lines fit in every row, so the menu's height never depends on the target. */
const ROW_MIN_HEIGHT = 50;
const HEADER_HEIGHT = 40;
const MENU_PADDING = 6;
/** Keep the card off the screen edges and clear of the finger. */
const EDGE_MARGIN = 12;
const ANCHOR_GAP = 14;
/** Matches `SHEET_CLOSE_MS` in lib/deferredNavigate.ts — see `handlePress`. */
const MENU_CLOSE_MS = 320;

const ESTIMATED_HEIGHT =
  HEADER_HEIGHT + ROW_MIN_HEIGHT * LONG_PRESS_ACTIONS.length + MENU_PADDING * 2;

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

/** Where in the window the press happened, in screen px. */
export interface LongPressAnchor {
  x: number;
  y: number;
}

function placeMenu(
  anchor: LongPressAnchor | null | undefined,
  win: { width: number; height: number },
): { left: number; top: number } {
  const maxLeft = Math.max(EDGE_MARGIN, win.width - MENU_WIDTH - EDGE_MARGIN);
  const maxTop = Math.max(EDGE_MARGIN, win.height - ESTIMATED_HEIGHT - EDGE_MARGIN);

  if (!anchor || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) {
    // No anchor supplied — centre it rather than guessing at a press point.
    return {
      left: clamp((win.width - MENU_WIDTH) / 2, EDGE_MARGIN, maxLeft),
      top: clamp((win.height - ESTIMATED_HEIGHT) / 2, EDGE_MARGIN, maxTop),
    };
  }

  const left = clamp(anchor.x - MENU_WIDTH / 2, EDGE_MARGIN, maxLeft);
  const below = anchor.y + ANCHOR_GAP;
  // Prefer below the finger; flip above when it would run off the bottom.
  const top =
    below + ESTIMATED_HEIGHT <= win.height - EDGE_MARGIN
      ? below
      : anchor.y - ANCHOR_GAP - ESTIMATED_HEIGHT;
  return { left, top: clamp(top, EDGE_MARGIN, maxTop) };
}

// ── Row presentation ──────────────────────────────────────────────────────────

const ACTION_ICONS: Record<string, React.ComponentType<{ size?: number; color?: string }>> = {
  meet_here: Users,
  save: Bookmark,
  add_to_trip: CalendarPlus,
  ask_compass: Compass,
  share: Share2,
  create_checkpoint: Milestone,
  report: Flag,
};

/** How the §23 rung a share is capped to reads to a human. */
const SHARE_RUNG_LABEL: Record<string, string> = {
  aggregate_only: 'Area only',
  approximate: 'Approximate',
  place_level: 'Place-level',
  precise_temporary: 'Exact, temporary',
};

/**
 * The share row's second line: what it shares, and for how long.
 *
 * Both halves are stated because both are the §37 bound — a rung with no expiry
 * is still permanent sharing, and an expiry with no rung still says nothing
 * about precision.
 */
export function shareBoundLabel(bound: LongPressShareBound): string {
  const rung = SHARE_RUNG_LABEL[bound.privacyClass] ?? 'Approximate';
  const minutes = Math.max(1, Math.round(bound.ttlMs / 60_000));
  return `${rung} · expires in ${minutes} min`;
}

/** The second line of a row: the §37 bound when enabled, the reason when not. */
function subtitleFor(item: LongPressItem | null): string | null {
  if (!item) return null;
  if (!item.enabled) return item.reason ?? 'Not available here';
  if (item.action === 'share' && item.shareBound) return shareBoundLabel(item.shareBound);
  return null;
}

// ── Component ─────────────────────────────────────────────────────────────────

export interface MapLongPressMenuProps {
  /** The press target — an object, or the bare coordinate that was pressed. */
  target: LongPressTarget | null;
  visible: boolean;
  /** Emitted for an ENABLED row only. The screen routes the slug to its flow. */
  onSelect: (action: MapAction, target: LongPressTarget) => void;
  onClose: () => void;
  /**
   * Screen coordinates of the press, so the menu opens under the finger.
   * Omitted ⇒ centred.
   */
  anchor?: LongPressAnchor | null;
  /**
   * Context the availability rules read: the group a checkpoint would go to,
   * the purpose/grant/TTL a share is opened under. Forwarded verbatim to
   * `resolveLongPressActions` — this component decides none of it.
   */
  context?: LongPressContext;
  /**
   * Optional hook for a disabled tap. When omitted the row simply does nothing
   * beyond the reason it already shows.
   */
  onUnavailable?: (action: MapAction, reason: string) => void;
}

export function MapLongPressMenu({
  target,
  visible,
  onSelect,
  onClose,
  anchor = null,
  context,
  onUnavailable,
}: MapLongPressMenuProps) {
  const win = useWindowDimensions();

  const items = useMemo(
    () => (visible ? resolveLongPressActions(target, context) : []),
    [visible, target, context],
  );

  const position = useMemo(
    () => placeMenu(anchor, { width: win.width, height: win.height }),
    [anchor, win.width, win.height],
  );

  const handlePress = useCallback(
    (item: LongPressItem) => {
      if (!target) return;
      if (!item.enabled) {
        if (onUnavailable) onUnavailable(item.action, item.reason ?? 'Not available here');
        return;
      }
      // Close first, THEN hand the slug over after the dismissal animation.
      // The screen's handler may push a route or open a sheet, and doing that
      // in the same tick as the close is the BUG CC/CD dead-back-button race
      // (see lib/deferredNavigate.ts). Deferring here means every handler the
      // screen wires up is safe, whether or not it happens to navigate.
      onClose();
      setTimeout(() => onSelect(item.action, target), MENU_CLOSE_MS);
    },
    [onClose, onSelect, onUnavailable, target],
  );

  if (!visible || !target) return null;

  const heading = describeTarget(target);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable
        style={s.backdrop}
        onPress={onClose}
        accessibilityLabel="Dismiss menu"
        accessibilityRole="button"
        testID="map-long-press-backdrop"
      />

      <View
        style={[s.menu, { left: position.left, top: position.top }]}
        accessibilityRole="menu"
        accessibilityLabel={`Actions for ${heading}`}
        testID="map-long-press-menu"
      >
        <View style={s.header}>
          <Text style={s.heading} numberOfLines={1} testID="map-long-press-title">
            {heading}
          </Text>
        </View>

        {LONG_PRESS_ACTIONS.map((spec) => {
          const item = longPressItemFor(items, spec.action);
          const enabled = item?.enabled === true;
          const subtitle = subtitleFor(item);
          const Icon = ACTION_ICONS[spec.action] ?? Compass;

          return (
            <Pressable
              key={spec.action}
              testID={`map-long-press-${spec.action}`}
              onPress={() => (item ? handlePress(item) : undefined)}
              style={({ pressed }) => [s.row, pressed && enabled && s.rowPressed]}
              accessibilityRole="menuitem"
              accessibilityLabel={spec.label}
              // The row stays tappable so a disabled action can explain itself;
              // `disabled` in the a11y state is what assistive tech announces.
              accessibilityState={{ disabled: !enabled }}
              accessibilityHint={subtitle ?? undefined}
            >
              <View style={[s.rowIcon, !enabled && s.dim]}>
                <Icon size={icon.s18} color={enabled ? ON_DARK : ON_DARK_FAINT} />
              </View>
              <View style={s.rowText}>
                <Text style={[s.rowLabel, !enabled && s.rowLabelDisabled]} numberOfLines={1}>
                  {spec.label}
                </Text>
                {subtitle ? (
                  <Text style={s.rowSubtitle} numberOfLines={2}>
                    {subtitle}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>
    </Modal>
  );
}

export default MapLongPressMenu;

// ── Styles ────────────────────────────────────────────────────────────────────

// Dark map chrome (§4), matching MapBottomActions' treatment so the two read as
// one control surface.
const MENU_BG = color.deep;
const MENU_BORDER = 'rgba(255,255,255,0.14)';
const ON_DARK = color.onInk;
const ON_DARK_FAINT = 'rgba(250,249,246,0.42)';

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(17,17,15,0.32)',
  },
  menu: {
    position: 'absolute',
    width: MENU_WIDTH,
    backgroundColor: MENU_BG,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: MENU_BORDER,
    paddingVertical: MENU_PADDING,
    paddingHorizontal: MENU_PADDING,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 18,
    elevation: 12,
  },
  header: {
    minHeight: HEADER_HEIGHT,
    justifyContent: 'center',
    paddingHorizontal: space.sm,
    paddingBottom: space.xs,
    borderBottomWidth: 1,
    borderBottomColor: MENU_BORDER,
  },
  heading: {
    ...t.stamp,
    color: color.onInkMute,
    textTransform: 'uppercase',
  },
  row: {
    minHeight: ROW_MIN_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    borderRadius: radius.md,
  },
  rowPressed: {
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  rowIcon: {
    width: icon.s24,
    alignItems: 'center',
  },
  dim: {
    opacity: 0.55,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowLabel: {
    ...t.small,
    fontSize: 14,
    fontWeight: '700',
    color: ON_DARK,
  },
  rowLabelDisabled: {
    color: ON_DARK_FAINT,
    fontWeight: '600',
  },
  rowSubtitle: {
    ...t.small,
    fontSize: 11,
    lineHeight: 14,
    color: color.onInkMute,
  },
});
