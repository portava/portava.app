/**
 * ActionRowIcon — action-row icons that render at one *visible* size.
 *
 * The icon-spacing spec §2 specifies "standard **visible** icon sizes" and ends
 * with "All icons must maintain the same visual baseline and perceived weight".
 * Passing the same `size` prop to every icon does NOT achieve that, because
 * `size` sets the SVG viewport, not the glyph, and the three icon families used
 * in action rows fill their viewBox by very different amounts:
 *
 *   family          viewBox    ink extent        ink / size
 *   ------          -------    ----------        ----------
 *   lucide          24 x 24    ~22 units          0.917
 *   PortavaShare    24 x 24    16.81 units        0.700
 *   StampIcon       40 x 36    24.1 units         0.603
 *
 * StampIcon is doubly penalised: its viewBox is non-square, so a square
 * `size x size` viewport letterboxes it at `size/40`, and its artwork occupies
 * only 22.6 of those 40 units. The measured result at a shared `size={20}` was
 * comment 18.4px, share 14.0px, stamp 11.3 x 12.1px — the stamp rendering at
 * 62% of the comment icon beside it, which is the reported bug. No amount of
 * "is the constant imported" checking catches this; the constant *was* shared
 * and identical at three of the call sites.
 *
 * This module compensates per family so a single token produces a single
 * rendered size. Lucide is the reference — lucide icons in an action row keep
 * using `icon.action` directly and are unchanged — and the two custom icons are
 * scaled up to match, then pinned inside an `icon.action` layout box so the row
 * geometry and baseline are unaffected by the larger viewport.
 *
 * Scope note: the deeper fix is to retighten StampIcon's and PortavaShareIcon's
 * own viewBoxes so their `size` prop means what lucide's does everywhere. That
 * is deliberately NOT done here — those components have 17 and 20 call sites
 * respectively, most outside action rows (passport, trips, events, share
 * sheets, burst animations), and changing their intrinsic geometry would resize
 * all of them. Until that happens, `<StampIcon size={20} />` still renders an
 * 11px glyph anywhere this module is not used.
 */
import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { icon } from '../../theme/tokens.ts';
import { StampIcon } from '../stamps/StampIcon.tsx';
import { PortavaShareIcon } from '../icons/PortavaShareIcon.tsx';

/** The canonical visible size for every icon in an action row (spec §2). */
export const ACTION_ICON_VISIBLE = icon.action;

/**
 * Measured ink extent as a fraction of the nominal `size` prop, per family.
 *
 * These are derived from each component's viewBox and artwork bounds, so they
 * are only valid while those viewBoxes hold. `ActionRowIcon.component.test.tsx`
 * pins both viewBoxes for exactly that reason — retightening one without
 * updating these ratios would silently re-break the alignment.
 *
 * - lucide: 24-unit grid, artwork bounded 2..22 with a 2-wide centred stroke,
 *   so the outer extent is 1..23 = 22 units.
 * - share:  path bounds 3.84..20.65 on a 24-unit viewBox = 16.81 units.
 * - stamp:  artwork 9.5..30.5 x, 5.5..28 y plus a 1.6 stroke (0.8 each side)
 *   on a 40x36 viewBox scaled by size/40 — the taller axis, 24.1 units, governs.
 */
export const ACTION_ICON_INK_RATIO = {
  lucide: 22 / 24,
  share: 16.81 / 24,
  stamp: 24.1 / 40,
} as const;

/** Rendered ink extent every action-row icon must match. Lucide is the reference. */
export const ACTION_ICON_INK = ACTION_ICON_VISIBLE * ACTION_ICON_INK_RATIO.lucide;

/** Nominal `size` each custom icon needs to render ACTION_ICON_INK of actual glyph. */
export const ACTION_STAMP_NOMINAL = ACTION_ICON_INK / ACTION_ICON_INK_RATIO.stamp;
export const ACTION_SHARE_NOMINAL = ACTION_ICON_INK / ACTION_ICON_INK_RATIO.share;

/**
 * Pins the layout box to the visible size regardless of the oversized viewport
 * inside it. The overflow is transparent SVG canvas, never glyph: at the
 * nominal sizes above the ink measures ACTION_ICON_INK (18.33px at a 20px
 * token), which fits inside the box on both axes.
 */
function ActionIconBox({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View
      style={[
        {
          width: ACTION_ICON_VISIBLE,
          height: ACTION_ICON_VISIBLE,
          alignItems: 'center',
          justifyContent: 'center',
        },
        style,
      ]}
      pointerEvents="none"
    >
      {children}
    </View>
  );
}

export interface ActionStampIconProps {
  active?: boolean;
  color?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Stamp glyph at the canonical action-row visible size. */
export function ActionStampIcon({ active, color, style, testID }: ActionStampIconProps) {
  return (
    <ActionIconBox style={style}>
      <StampIcon size={ACTION_STAMP_NOMINAL} active={active} color={color} testID={testID} />
    </ActionIconBox>
  );
}

export interface ActionShareIconProps {
  color?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Portava share mark at the canonical action-row visible size. */
export function ActionShareIcon({ color, style, testID }: ActionShareIconProps) {
  return (
    <ActionIconBox style={style}>
      <PortavaShareIcon size={ACTION_SHARE_NOMINAL} color={color} testID={testID} />
    </ActionIconBox>
  );
}
