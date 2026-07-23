/**
 * VerifiedBadge — the single source of truth for rendering a user's
 * verification level anywhere identity appears.
 *
 * Drop at: travel-buddy-standalone/src/components/VerifiedBadge.tsx
 *
 * Levels:
 *   'none'                → renders nothing
 *   'id_verified'         → teal check-shield
 *   'id_selfie_verified'  → gold check-shield (highest tier: ID + selfie match)
 *
 * Usage:
 *   <VerifiedBadge level={profile.verification_level} size={14} />
 *
 * Pairs with UserIdentityLink: place the badge inside the identity link so
 * tapping it still opens the profile (the badge itself is decorative and
 * must NOT swallow taps — pointerEvents none).
 */

import React from 'react';
import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

export type VerificationLevel = 'none' | 'id_verified' | 'id_selfie_verified';

const COLORS: Record<Exclude<VerificationLevel, 'none'>, string> = {
  id_verified: '#0897B7', // teal — matches brand cool gradient
  id_selfie_verified: '#D9A441', // gold — highest trust tier
};

export function VerifiedBadge({
  level,
  size = 14,
}: {
  level: VerificationLevel | null | undefined;
  size?: number;
}) {
  if (!level || level === 'none') return null;

  const color = COLORS[level];

  return (
    <View
      pointerEvents="none"
      accessibilityLabel={
        level === 'id_selfie_verified' ? 'Identity and selfie verified' : 'Identity verified'
      }
      style={{ width: size, height: size, marginLeft: 4 }}
    >
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        {/* Shield */}
        <Path
          d="M12 2l8 3.5v5.2c0 5-3.4 8.6-8 10.3-4.6-1.7-8-5.3-8-10.3V5.5L12 2z"
          fill={color}
        />
        {/* Check */}
        <Path
          d="M8.2 12.2l2.4 2.4 5-5.2"
          stroke="#FFFFFF"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    </View>
  );
}

export default VerifiedBadge;
