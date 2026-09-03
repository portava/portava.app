/**
 * PassportQrCode — renders a QR matrix as a single crisp SVG path.
 *
 * Uses the dependency-free encoder in qrEncode.ts (no QR library added) and
 * draws every dark module as one rect inside a single <Path>, which is far
 * lighter than one <Rect> per module. A quiet zone (4 modules, the QR spec
 * minimum) is baked into the viewBox so scanners lock on reliably.
 *
 * `value` is the string encoded — for the Passport this is only the deep link
 * (see passportQrProjection.buildQrPayload); no personal data is encoded.
 */
import React, { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import Svg, { Rect, Path } from 'react-native-svg';
import { encodeQr, type QrErrorCorrectionLevel } from './qrEncode.ts';

export interface PassportQrCodeProps {
  value: string;
  /** Rendered pixel size of the square (excluding quiet zone scaling). */
  size?: number;
  ecc?: QrErrorCorrectionLevel;
  /** Dark module color. */
  color?: string;
  /** Background (quiet-zone) color. */
  background?: string;
}

const QUIET_ZONE = 4;

function toPath(modules: boolean[][]): string {
  let d = '';
  for (let r = 0; r < modules.length; r++) {
    const row = modules[r];
    for (let c = 0; c < row.length; c++) {
      if (row[c]) {
        // 1×1 module at (c + quiet, r + quiet) in module units.
        d += `M${c + QUIET_ZONE} ${r + QUIET_ZONE}h1v1h-1z`;
      }
    }
  }
  return d;
}

export function PassportQrCode({
  value,
  size = 200,
  ecc = 'M',
  color = '#11110F',
  background = '#FFFFFF',
}: PassportQrCodeProps) {
  const { total, path } = useMemo(() => {
    const { size: count, modules } = encodeQr(value, ecc);
    return { total: count + QUIET_ZONE * 2, path: toPath(modules) };
  }, [value, ecc]);

  return (
    <View style={[styles.wrap, { width: size, height: size }]} accessibilityRole="image" accessibilityLabel="Passport QR code">
      <Svg width={size} height={size} viewBox={`0 0 ${total} ${total}`}>
        <Rect x={0} y={0} width={total} height={total} fill={background} />
        <Path d={path} fill={color} />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
