/**
 * PassportSecurityPattern — subtle guilloche/security-line texture overlay.
 * Rendered as absolute-fill behind identity card content.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Defs, Pattern, Rect, Path, Line } from 'react-native-svg';
import { PP } from '../../theme/passportTokens.ts';

interface Props {
  opacity?: number;
}

export function PassportSecurityPattern({ opacity = 1 }: Props) {
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity }]}>
      <Svg width="100%" height="100%" style={StyleSheet.absoluteFill}>
        <Defs>
          {/* Diagonal fine-line pattern */}
          <Pattern id="pp-diag" width="16" height="16" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <Line x1="0" y1="0" x2="0" y2="16" stroke={PP.securityLine} strokeWidth="0.8" />
          </Pattern>
          {/* Micro wave pattern */}
          <Pattern id="pp-wave" width="24" height="12" patternUnits="userSpaceOnUse">
            <Path
              d="M0,6 Q6,0 12,6 T24,6"
              stroke={PP.securityLine}
              strokeWidth="0.6"
              fill="none"
            />
          </Pattern>
        </Defs>
        {/* Layer 1: diagonal lines */}
        <Rect width="100%" height="100%" fill="url(#pp-diag)" />
        {/* Layer 2: wave overlay (lighter) */}
        <Rect width="100%" height="100%" fill="url(#pp-wave)" opacity={0.5} />
      </Svg>
    </View>
  );
}
