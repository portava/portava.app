/**
 * OfficialBadge — inline badge for @Portava Official accounts.
 *
 * Visually distinct from VerifiedStamp in every dimension:
 *   • Shape   — gold shield (not a dashed passport-stamp circle)
 *   • Colour  — warm gold (#C8890A) instead of navy (#1A3A5C)
 *   • Symbol  — "P" initial inside the shield (not an airplane)
 *
 * These differences make it impossible to confuse with a regular verified-traveler badge.
 *
 * Props:
 *   size  — 'sm' (14 px) for inline name rows, 'md' (22 px) for profile headers.
 */
import React from 'react';
import Svg, { Path, Text as SvgText } from 'react-native-svg';

interface OfficialBadgeProps {
  /** Badge size variant. sm = 14 px, md = 22 px. Default 'sm'. */
  size?: 'sm' | 'md';
}

const SM = 14;
const MD = 22;

/** Gold ink used for stroke + text */
const GOLD_INK = '#C8890A';
/** Pale amber fill inside the shield */
const GOLD_FILL = '#FEF3C7';

export function OfficialBadge({ size = 'sm' }: OfficialBadgeProps) {
  const px = size === 'md' ? MD : SM;

  return (
    <Svg
      width={px}
      height={px}
      viewBox="0 0 30 32"
      accessibilityLabel="Portava Official"
      accessibilityRole="image"
      style={{ marginLeft: 2 }}
    >
      {/* Shield body — classic heraldic shield shape */}
      <Path
        d="M15,2 L27,7 L27,16.5 C27,22.8 21.8,28 15,30 C8.2,28 3,22.8 3,16.5 L3,7 Z"
        fill={GOLD_FILL}
        stroke={GOLD_INK}
        strokeWidth={1.8}
        strokeLinejoin="round"
      />
      {/* "P" initial — Portava brand mark */}
      <SvgText
        x="15"
        y="22.5"
        textAnchor="middle"
        fill={GOLD_INK}
        fontSize="14"
        fontWeight="800"
      >
        P
      </SvgText>
    </Svg>
  );
}
