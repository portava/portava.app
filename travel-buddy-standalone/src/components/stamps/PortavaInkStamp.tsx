/**
 * PortavaInkStamp — circular passport-seal SVG overlay.
 *
 * Renders as a semi-transparent ink stamp that can be absolutely positioned
 * over any content. Animation (entry/exit) is driven by the caller via the
 * `animatedStyle` prop from `useStampAnimation`.
 *
 * Themed variants change the center icon and ring text while keeping the
 * circular seal shape and interaction identical.
 */
import React from 'react';
import Animated from 'react-native-reanimated';
import type { StyleProp, ViewStyle } from 'react-native';
import Svg, {
  Circle,
  Path,
  Defs,
  Text as SvgText,
  TextPath,
} from 'react-native-svg';
import { color } from '../../theme/tokens.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StampTheme =
  | 'Default'
  | 'Beach'
  | 'Mountain'
  | 'Food'
  | 'Nightlife'
  | 'Festival'
  | 'Landmark'
  | 'Adventure';

interface ThemeConfig {
  ringText: string;
  /** SVG path `d` attribute for the center icon (viewBox 0 0 160 160). */
  centerPath: string;
}

// ---------------------------------------------------------------------------
// Theme configs
// ---------------------------------------------------------------------------

const THEMES: Record<StampTheme, ThemeConfig> = {
  Default: {
    ringText: 'PORTAVA · STAMPED · 2026',
    // 5-pointed star centered at 80,80
    centerPath:
      'M80 65L83.5 75.7H95L85.7 81.7L89.2 92.4L80 86.4L70.8 92.4L74.3 81.7L65 75.7H76.5Z',
  },
  Beach: {
    ringText: 'PORTAVA · BEACH · 2026',
    // Sun + wave: circle top + wave below
    centerPath:
      'M80 68A6 6 0 1 0 80 80A6 6 0 0 0 80 68Z ' +
      'M66 84C70 79 74 89 78 84S86 79 90 84S94 89 94 84',
  },
  Mountain: {
    ringText: 'PORTAVA · SUMMIT · 2026',
    // Mountain peak with snow cap
    centerPath:
      'M80 66L95 90H65Z M73 82L80 70L87 82Z',
  },
  Food: {
    ringText: 'PORTAVA · FOODIE · 2026',
    // Fork (left) + knife (right)
    centerPath:
      'M74 68V88 M72 68V73C72 75 76 75 76 73V68 M74 75V88 ' +
      'M86 68V88 M86 68C88 68 90 70 90 73C90 76 86 77 86 77',
  },
  Nightlife: {
    ringText: 'PORTAVA · NIGHT · 2026',
    // Crescent moon
    centerPath:
      'M86 69A13 13 0 1 0 86 91A9 9 0 1 1 86 69Z',
  },
  Festival: {
    ringText: 'PORTAVA · FIESTA · 2026',
    // Sparkle / burst: cross + diagonal lines
    centerPath:
      'M80 67V93 M67 80H93 M71 71L89 89 M89 71L71 89',
  },
  Landmark: {
    ringText: 'PORTAVA · LANDMARK · 2026',
    // Classical arch / monument
    centerPath:
      'M68 90V74H92V90 M74 74V90 M86 74V90 M68 78H92 ' +
      'M75 90V82A5 5 0 0 1 85 82V90Z',
  },
  Adventure: {
    ringText: 'PORTAVA · ADVENTURE · 2026',
    // Compass rose: 4-point with needle
    centerPath:
      'M80 67V93 M67 80H93 ' +
      'M80 67L84 78L80 74L76 78Z ' +
      'M80 93L76 82L80 86L84 82Z',
  },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  /** Reanimated animated style driving opacity / scale / rotation / offset. */
  animatedStyle: StyleProp<ViewStyle>;
  /** Thematic variant (default: 'Default'). */
  theme?: StampTheme;
  /** Stamp diameter in px (default: 140). */
  size?: number;
  /** Additional style for the outer Animated.View wrapper. */
  style?: ViewStyle;
}

/**
 * PortavaInkStamp
 *
 * Place this as an absolutely-positioned sibling over the target content.
 * Drive its visibility with `animatedStyle` from `useStampAnimation`.
 *
 * @example
 * <PortavaInkStamp
 *   animatedStyle={overlayStyle}
 *   theme="Beach"
 *   style={StyleSheet.absoluteFillObject}
 * />
 */
export function PortavaInkStamp({
  animatedStyle,
  theme = 'Default',
  size = 140,
  style,
}: Props) {
  const cfg = THEMES[theme];
  const c = color.signal; // vermilion — full color; container opacity drives the 60% wash

  // All geometry is relative to viewBox 0 0 160 160 (center 80,80)
  const arcId = `portava-arc-${theme}`;

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          width: size,
          height: size,
          alignItems: 'center',
          justifyContent: 'center',
        },
        style,
        animatedStyle,
      ]}
    >
      <Svg width={size} height={size} viewBox="0 0 160 160">
        <Defs>
          {/* Arc path for ring text — top semicircle */}
          <Path
            id={arcId}
            d="M 15,80 A 65,65 0 0,1 145,80"
            fill="none"
          />
        </Defs>

        {/* Outer ring */}
        <Circle
          cx={80}
          cy={80}
          r={72}
          stroke={c}
          strokeWidth={2.5}
          fill="none"
        />

        {/* Inner ring */}
        <Circle
          cx={80}
          cy={80}
          r={58}
          stroke={c}
          strokeWidth={1.5}
          fill="none"
        />

        {/* Ring text along top arc */}
        <SvgText
          fill={c}
          fontSize={11}
          fontWeight="700"
          letterSpacing={1.5}
          fontFamily="Courier"
        >
          <TextPath href={`#${arcId}`} startOffset="50%" textAnchor="middle">
            {cfg.ringText}
          </TextPath>
        </SvgText>

        {/* Center icon */}
        <Path
          d={cfg.centerPath}
          stroke={c}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </Svg>
    </Animated.View>
  );
}
