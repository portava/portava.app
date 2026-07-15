/**
 * PassportIcon — custom line icon for the Passport tab.
 *
 * Lucide has no passport glyph, so this draws one in the exact same visual
 * language (24×24 viewBox, 2px rounded strokes, no fill): a booklet outline
 * with a subtle globe (circle + equator) and a data line underneath.
 * Accepts the same { size, color, strokeWidth } props the lucide components
 * take so it can be used interchangeably in NAV_ITEMS.
 */
import React from 'react';
import Svg, { Rect, Circle, Path } from 'react-native-svg';

export function PassportIcon({
  size = 20,
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
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* Booklet cover */}
      <Rect x={5} y={2.75} width={14} height={18.5} rx={2.5} />
      {/* Globe emblem */}
      <Circle cx={12} cy={9.5} r={3.1} />
      {/* Equator across the globe */}
      <Path d="M8.9 9.5h6.2" />
      {/* Machine-readable data line */}
      <Path d="M9 17h6" />
    </Svg>
  );
}
