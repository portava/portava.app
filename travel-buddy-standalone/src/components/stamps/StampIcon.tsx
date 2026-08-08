/**
 * StampIcon — rubber-stamp SVG glyph per Portava brand spec.
 *
 * Idle:   outline only, neutral color
 * Active: base plate filled, surface line bolder, whole icon rotated −7°, signal/vermilion
 */
import React from 'react';
import Svg, { Rect, Path, G } from 'react-native-svg';
import { color as tokens } from '../../theme/tokens.ts';

export interface StampIconProps {
  /** Rendered width/height in px (default 24). */
  size?: number;
  /** Whether the stamp is in the "stamped" / active state. */
  active?: boolean;
  /** Override stroke/fill color. Defaults to signal (active) or mute (idle). */
  color?: string;
  testID?: string;
}

export function StampIcon({ size = 24, active = false, color: colorProp, testID }: StampIconProps) {
  const c = colorProp ?? (active ? tokens.signal : tokens.mute);
  const strokeW = 1.6;

  return (
    <Svg width={size} height={size} viewBox="0 0 40 36" fill="none" testID={testID}>
      <G
        stroke={c}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeW}
        rotation={active ? -7 : 0}
        origin="20,18"
      >
        {/* Knob — top of the rubber stamp handle */}
        <Rect x={16.5} y={5.5} width={7} height={4} rx={2} />

        {/* Neck lines connecting knob to base plate */}
        <Path d="M16.8 9.5 L12 18" />
        <Path d="M23.2 9.5 L28 18" />

        {/* Base plate — filled when active */}
        <Rect
          x={9.5}
          y={18}
          width={21}
          height={4.8}
          rx={1.8}
          fill={active ? c : 'none'}
        />

        {/* Surface / ink line — bolder when active */}
        <Path
          d="M9.5 28 L30.5 28"
          strokeWidth={active ? 2.5 : strokeW}
        />
      </G>
    </Svg>
  );
}
