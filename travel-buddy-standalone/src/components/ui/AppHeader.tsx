/**
 * AppHeader — consolidated shared header component.
 *
 * Variants:
 *  primary  — large page title that participates in scroll layout; right action row.
 *  detail   — back chevron + centered title + optional right actions; stack screens.
 *  search   — focused search TextInput replaces the title; cancel button.
 *  modal    — close (X) button left + centered title + optional right action.
 *  overlay  — semi-transparent absolutely-positioned header for full-screen media.
 *
 * Safe-area top insets are applied internally. Consumer screens must NOT add
 * redundant paddingTop above this component.
 *
 * rightActions accepts up to 3 items. Pass a self-contained component (e.g.
 * NotificationBell) with onPress omitted — it renders bare without an extra
 * wrapping Pressable so its own touch handler remains active.
 *
 * overflowActions appear in a bottom sheet triggered by a MoreHorizontal icon
 * that is appended automatically after rightActions when the array is non-empty.
 */
import React, { useState } from 'react';
import {
  View, Text, Pressable, TextInput, StyleSheet, Modal,
  TouchableOpacity,
} from 'react-native';
import Animated from 'react-native-reanimated';
import type { AnimatedStyle } from 'react-native-reanimated';
import type { ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft, X, MoreHorizontal } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

/** Exported so overlay consumers (e.g. media mode selector) can offset content. */
export const OVERLAY_HEADER_HEIGHT = 44;

/**
 * Total on-screen height of the `overlay`/`detail`/`modal` header bar, including
 * its top safe-area padding. The header floors its top padding at 54 (so it
 * never sits too high on devices/web where `insets.top` is 0), so consumers
 * MUST use this helper — not `insets.top + OVERLAY_HEADER_HEIGHT` — to compute
 * where content below the header should start. Using the raw sum silently
 * under-counts the header's real height whenever `insets.top < 54`, causing
 * the header title to visually overlap whatever is positioned "below" it.
 */
export function getOverlayHeaderTotalHeight(insetsTop: number): number {
  return Math.max(insetsTop, 54) + OVERLAY_HEADER_HEIGHT;
}

export type AppHeaderVariant = 'primary' | 'detail' | 'search' | 'modal' | 'overlay';

export interface AppHeaderAction {
  /**
   * Icon element or fully self-contained component. When `onPress` is provided
   * the element is wrapped in a Pressable; when omitted it renders bare
   * (use for components like NotificationBell that own their press handling).
   */
  icon: React.ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
}

export interface AppHeaderOverflowItem {
  label: string;
  onPress: () => void;
  destructive?: boolean;
}

export interface AppHeaderSearchProps {
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  onCancel?: () => void;
  autoFocus?: boolean;
}

export interface AppHeaderProps {
  variant: AppHeaderVariant;
  title?: string;
  /** Secondary line shown below the title (primary and detail only). */
  subtitle?: string;
  /**
   * Back chevron (detail/overlay) or ✕ (modal) on the left.
   * When omitted no left affordance is rendered.
   */
  onBack?: () => void;
  /** Up to 3 action slots on the right. */
  rightActions?: AppHeaderAction[];
  /** Shown in a bottom sheet via an auto-appended MoreHorizontal icon. */
  overflowActions?: AppHeaderOverflowItem[];
  /** search variant only — controls the TextInput. */
  searchProps?: AppHeaderSearchProps;
  /** overlay variant: use a fully transparent background instead of the tint. */
  transparent?: boolean;
  /**
   * primary variant only — Reanimated animated style (from useCollapsingHeader's
   * `largeHeaderStyle`) applied to the wrapper so the large title fades and
   * slides upward as the compact sticky bar fades in during down-scroll.
   */
  animatedStyle?: AnimatedStyle<ViewStyle>;
}

export function AppHeader({
  variant,
  title,
  subtitle,
  onBack,
  rightActions = [],
  overflowActions = [],
  searchProps,
  transparent = false,
  animatedStyle,
}: AppHeaderProps) {
  const insets = useSafeAreaInsets();
  const [overflowOpen, setOverflowOpen] = useState(false);

  const hasOverflow = overflowActions.length > 0;

  // ── Overflow bottom-sheet ─────────────────────────────────────────────────
  const overflowSheet = (
    <Modal
      visible={overflowOpen}
      transparent
      animationType="fade"
      onRequestClose={() => setOverflowOpen(false)}
    >
      <Pressable style={s.scrim} onPress={() => setOverflowOpen(false)}>
        <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, space.lg) }]}>
          {overflowActions.map((item, i) => (
            <TouchableOpacity
              key={i}
              style={[s.sheetItem, i < overflowActions.length - 1 && s.sheetItemBorder]}
              onPress={() => { setOverflowOpen(false); item.onPress(); }}
            >
              <Text style={[s.sheetLabel, item.destructive && s.sheetDestructive]}>
                {item.label}
              </Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            style={[s.sheetItem, s.sheetCancel]}
            onPress={() => setOverflowOpen(false)}
          >
            <Text style={s.sheetCancelLabel}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </Pressable>
    </Modal>
  );

  // ── Helpers ───────────────────────────────────────────────────────────────
  const renderActions = (overflowIconColor: string = color.ink) => (
    <View style={s.actionsRow}>
      {rightActions.slice(0, 3).map((action, i) =>
        action.onPress ? (
          <Pressable
            key={i}
            onPress={action.onPress}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={action.accessibilityLabel}
            style={s.actionSlot}
          >
            {action.icon}
          </Pressable>
        ) : (
          <View key={i} style={s.actionSlot}>{action.icon}</View>
        )
      )}
      {hasOverflow && (
        <Pressable
          style={s.actionSlot}
          onPress={() => setOverflowOpen(true)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="More options"
        >
          <MoreHorizontal size={22} color={overflowIconColor} />
        </Pressable>
      )}
    </View>
  );

  /** Centered title via absoluteFillObject; pointerEvents="none" so touches reach buttons. */
  const centeredTitle = (textColor: string = color.ink) => (
    <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
      <View style={s.barTitleWrap}>
        <Text style={[s.barTitle, { color: textColor }]} numberOfLines={1}>{title}</Text>
      </View>
    </View>
  );

  // ── primary ───────────────────────────────────────────────────────────────
  if (variant === 'primary') {
    const primaryInner = (
      <View style={[s.primary, { paddingTop: insets.top + space.sm }]}>
        <View style={s.primaryRow}>
          <Text style={s.primaryTitle} numberOfLines={1}>{title}</Text>
          {renderActions()}
        </View>
        {subtitle ? <Text style={s.subtitle}>{subtitle}</Text> : null}
      </View>
    );
    return (
      <>
        {animatedStyle
          ? <Animated.View style={animatedStyle}>{primaryInner}</Animated.View>
          : primaryInner}
        {overflowSheet}
      </>
    );
  }

  // ── detail ────────────────────────────────────────────────────────────────
  if (variant === 'detail') {
    return (
      <>
        <View style={[s.detailOuter, { paddingTop: Math.max(insets.top, 54) }]}>
          <View style={s.bar}>
            {centeredTitle()}
            <View style={s.barLeft}>
              {onBack && (
                <Pressable
                  onPress={onBack}
                  hitSlop={8}
                  style={s.backBtn}
                  accessibilityLabel="Back"
                  accessibilityRole="button"
                >
                  <ChevronLeft size={26} color={color.ink} />
                </Pressable>
              )}
            </View>
            <View style={{ flex: 1 }} />
            {renderActions()}
          </View>
          {subtitle ? (
            <Text style={[s.subtitle, { paddingHorizontal: space.lg, paddingBottom: space.xs }]}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {overflowSheet}
      </>
    );
  }

  // ── search ────────────────────────────────────────────────────────────────
  if (variant === 'search') {
    return (
      <View style={[s.searchOuter, { paddingTop: insets.top }]}>
        <View style={s.searchRow}>
          <TextInput
            style={s.searchInput}
            value={searchProps?.value ?? ''}
            onChangeText={searchProps?.onChangeText}
            placeholder={searchProps?.placeholder ?? 'Search…'}
            placeholderTextColor={color.faint}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
            autoFocus={searchProps?.autoFocus ?? true}
            clearButtonMode="while-editing"
          />
          <Pressable
            style={s.cancelBtn}
            onPress={searchProps?.onCancel}
            accessibilityLabel="Cancel search"
          >
            <Text style={s.cancelText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // ── modal ─────────────────────────────────────────────────────────────────
  if (variant === 'modal') {
    return (
      <>
        <View style={[s.detailOuter, { paddingTop: Math.max(insets.top, 54) }]}>
          <View style={s.bar}>
            {centeredTitle()}
            <View style={s.barLeft}>
              {onBack && (
                <Pressable
                  onPress={onBack}
                  hitSlop={8}
                  accessibilityLabel="Close"
                  accessibilityRole="button"
                >
                  <X size={24} color={color.ink} />
                </Pressable>
              )}
            </View>
            <View style={{ flex: 1 }} />
            {renderActions()}
          </View>
        </View>
        {overflowSheet}
      </>
    );
  }

  // ── overlay ───────────────────────────────────────────────────────────────
  const overlayBg = transparent ? 'transparent' : 'rgba(0,0,0,0.28)';
  return (
    <>
      <View style={[s.overlayOuter, { paddingTop: Math.max(insets.top, 54), backgroundColor: overlayBg }]}>
        <View style={s.bar}>
          {centeredTitle('#fff')}
          <View style={s.barLeft}>
            {onBack && (
              <Pressable
                onPress={onBack}
                hitSlop={8}
                accessibilityLabel="Back"
                accessibilityRole="button"
              >
                <ChevronLeft size={26} color="#fff" />
              </Pressable>
            )}
          </View>
          <View style={{ flex: 1 }} />
          {renderActions('#fff')}
        </View>
      </View>
      {overflowSheet}
    </>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  // ── primary ───────────────────────────────────────────────────────────────
  primary: {
    backgroundColor: color.paper,
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  primaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 40,
    gap: space.sm,
  },
  primaryTitle: {
    flex: 1,
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '800',
    letterSpacing: -0.6,
    color: color.ink,
  },
  subtitle: {
    ...t.small,
    color: color.mute,
    marginTop: 2,
    marginBottom: 2,
  },

  // ── detail / modal outer ──────────────────────────────────────────────────
  detailOuter: {
    backgroundColor: color.paper,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },

  // ── shared bar (detail / modal / overlay) ─────────────────────────────────
  bar: {
    height: OVERLAY_HEADER_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
  },
  barLeft: {
    minWidth: 32,
    justifyContent: 'center',
  },
  backBtn: {
    marginLeft: -6,
  },
  barTitleWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 48,
  },
  barTitle: {
    ...t.heading,
    textAlign: 'center',
  },

  // ── actions ───────────────────────────────────────────────────────────────
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  actionSlot: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ── search ────────────────────────────────────────────────────────────────
  searchOuter: {
    backgroundColor: color.paper,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    height: OVERLAY_HEADER_HEIGHT,
    gap: space.sm,
  },
  searchInput: {
    flex: 1,
    height: 36,
    borderRadius: radius.sm,
    backgroundColor: color.haze,
    paddingHorizontal: space.md,
    fontSize: 15,
    lineHeight: 22,
    color: color.ink,
  },
  cancelBtn: { paddingVertical: space.xs },
  cancelText: { ...t.bodyStrong, color: color.signal },

  // ── overlay ───────────────────────────────────────────────────────────────
  overlayOuter: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
  },

  // ── overflow sheet ────────────────────────────────────────────────────────
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.42)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: color.paper,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingTop: space.sm,
  },
  sheetItem: {
    paddingHorizontal: space.xl,
    paddingVertical: 15,
  },
  sheetItemBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.haze,
  },
  sheetCancel: { marginTop: space.xs },
  sheetLabel: { ...t.bodyStrong, color: color.ink, textAlign: 'center' },
  sheetDestructive: { color: '#E53935' },
  sheetCancelLabel: { ...t.bodyStrong, color: color.mute, textAlign: 'center' },
});
