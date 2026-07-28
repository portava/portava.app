/**
 * TelegraphSendIcon — custom stroke-only SVG icon for the in-app Telegraph send action.
 *
 * Compass ring with four short inward cardinal tick marks and a navigation/send
 * arrow (concave-notch triangle pointing upper-right). Visually distinct from the
 * system-share Share2 icon (Lucide) that remains on off-platform / native-share
 * buttons.
 *
 * Accepts the same { size, color, strokeWidth } props Lucide components take so
 * it can be used interchangeably alongside them.
 *
 * Shape derived from portava-send-compass-outline.svg (24×24 viewBox).
 */
import React from 'react';
import Svg, { Circle, Path } from 'react-native-svg';

export function TelegraphSendIcon({
  size = 24,
  color = '#000',
  strokeWidth = 2,
}: {
  size?: number;
  color?: string;
  strokeWidth?: number;
}) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
    >
      {/* Compass ring */}
      <Circle
        cx={12}
        cy={12}
        r={8.5}
        stroke={color}
        strokeWidth={strokeWidth}
      />

      {/* Cardinal tick marks — each starts at the ring edge and extends inward ~1.55 units */}
      <Path
        d="M12 3.5v1.55M20.5 12h-1.55M12 20.5v-1.55M3.5 12h1.55"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />

      {/* Navigation / send arrow — stroke-only concave-notch triangle pointing upper-right */}
      <Path
        d="M8.25 11.55 15.9 8.6c.5-.19.99.3.8.8l-2.95 7.65c-.2.52-.94.54-1.17.03l-1.15-2.55a.7.7 0 0 0-.35-.35l-2.55-1.15c-.51-.23-.49-.97.03-1.17Z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
    </Svg>
  );
}
