/**
 * VerifiedStamp — inline passport-stamp airplane badge for verified users.
 *
 * Rendered next to every username when `verified === true`.
 * Uses an SVG so the stamp border, rotation, and inner artwork all scale
 * cleanly at any size.
 *
 * Props:
 *   size  — 'sm' (14 px) for inline name rows, 'md' (22 px) for profile headers.
 *   dark  — true when the badge sits on a dark/scrim background (Watch overlay etc.)
 */
import React from 'react';
import Svg, { Circle, Path, Text as SvgText } from 'react-native-svg';

interface VerifiedStampProps {
  /** Badge size variant. sm = 14 px, md = 22 px. Default 'sm'. */
  size?: 'sm' | 'md';
  /** Use light ink when rendering on a dark background. Default false. */
  dark?: boolean;
}

const SM = 14;
const MD = 22;

export function VerifiedStamp({ size = 'sm', dark = false }: VerifiedStampProps) {
  const px = size === 'md' ? MD : SM;
  const ink = dark ? 'rgba(250,249,246,0.92)' : '#1A3A5C';
  const innerOpacity = dark ? '0.45' : '0.55';
  const dotsOpacity = dark ? '0.5' : '0.6';

  return (
    <Svg
      width={px}
      height={px}
      viewBox="0 0 30 30"
      accessibilityLabel="Verified traveler"
      accessibilityRole="image"
      style={{ marginLeft: 2 }}
    >
      {/* Outer dashed stamp border */}
      <Circle cx={15} cy={15} r={13} stroke={ink} strokeWidth={2} strokeDasharray="3 1.5" fill="none" />
      {/* Inner ring */}
      <Circle cx={15} cy={15} r={9.5} stroke={ink} strokeWidth={0.8} fill="none" opacity={innerOpacity} />
      {/* Airplane silhouette */}
      <Path
        d="M7.5 16.5 L12 9 L14 11.5 L10.5 14.5 L18 16.8 L16 19.2 L9.5 17 L10.5 21 L8.5 22 Z"
        fill={ink}
        opacity={0.9}
      />
      {/* Decorative dots along bottom */}
      <SvgText
        x="15"
        y="27.5"
        textAnchor="middle"
        fill={ink}
        fontSize="3.5"
        fontWeight="800"
        opacity={dotsOpacity}
      >
        ✦ ✦ ✦
      </SvgText>
    </Svg>
  );
}
