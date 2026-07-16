/**
 * StampSvgFrame — internal SVG layer used by all stamp components.
 *
 * Renders the background fill + pattern + border for a stamp.
 * All coordinate math is relative to `size × size` viewBox.
 */
import React from 'react';
import Svg, {
  Ellipse, Circle, Rect, Polygon, Defs,
  RadialGradient, Stop, Line, G, ClipPath,
} from 'react-native-svg';
import type { StampShape, StampBorderStyle, StampPattern } from '../types/stampArtwork.ts';

interface Props {
  size: number;
  shape: StampShape;
  borderStyle: StampBorderStyle;
  borderWeight: 1 | 2 | 3 | 4;
  accent: string;
  background: string;
  pattern: StampPattern;
  locked?: boolean;
}

function hexPoints(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    pts.push(`${(cx + r * Math.cos(angle)).toFixed(1)},${(cy + r * Math.sin(angle)).toFixed(1)}`);
  }
  return pts.join(' ');
}

/** Convert StampBorderStyle to SVG strokeDasharray. */
function dashArray(style: StampBorderStyle, w: number): string | undefined {
  switch (style) {
    case 'single':   return undefined;
    case 'double':   return undefined; // handled via two shapes
    case 'dotted':   return `${w * 2},${w * 4}`;
    case 'sawtooth': return `${w * 5},${w * 3}`;
    case 'wave':     return `${w * 7},${w * 3}`;
    default:         return undefined;
  }
}

function strokeLinecap(style: StampBorderStyle): 'butt' | 'round' | 'square' {
  switch (style) {
    case 'wave':     return 'round';
    case 'dotted':   return 'round';
    case 'sawtooth': return 'square';
    default:         return 'butt';
  }
}

/** Pattern overlay lines (dots / grid / diagonal) drawn over the fill. */
function PatternOverlay({
  size, pattern, accent,
}: { size: number; pattern: StampPattern; accent: string }) {
  const opacity = 0.07;
  if (pattern === 'solid') return null;

  if (pattern === 'radial') {
    return (
      <Defs>
        <RadialGradient id={`rg_${size}`} cx="50%" cy="40%" rx="60%" ry="60%">
          <Stop offset="0%" stopColor={accent} stopOpacity={0.12} />
          <Stop offset="100%" stopColor={accent} stopOpacity={0} />
        </RadialGradient>
      </Defs>
    );
  }

  const lines: React.ReactElement[] = [];
  if (pattern === 'grid') {
    const step = size / 8;
    for (let i = 1; i < 8; i++) {
      lines.push(
        <Line key={`h${i}`} x1={0} y1={i * step} x2={size} y2={i * step} stroke={accent} strokeWidth={0.5} opacity={opacity} />,
        <Line key={`v${i}`} x1={i * step} y1={0} x2={i * step} y2={size} stroke={accent} strokeWidth={0.5} opacity={opacity} />,
      );
    }
  } else if (pattern === 'diagonal') {
    const step = size / 6;
    for (let i = -6; i < 12; i++) {
      const x = i * step;
      lines.push(
        <Line key={i} x1={x} y1={0} x2={x + size} y2={size} stroke={accent} strokeWidth={0.6} opacity={opacity} />,
      );
    }
  } else if (pattern === 'dots') {
    const step = size / 7;
    const r = 1.2;
    for (let row = 0; row <= 7; row++) {
      for (let col = 0; col <= 7; col++) {
        lines.push(
          <Circle key={`${row}_${col}`} cx={col * step} cy={row * step} r={r} fill={accent} opacity={opacity * 1.5} />,
        );
      }
    }
  }

  return <G>{lines}</G>;
}

export function StampSvgFrame({
  size, shape, borderStyle, borderWeight, accent, background, pattern, locked,
}: Props) {
  const cx = size / 2;
  const cy = size / 2;
  const pad = borderWeight * 2 + 2;
  const sw = borderWeight * 1.5;
  const dash = dashArray(borderStyle, borderWeight);
  const linecap = strokeLinecap(borderStyle);
  const isDouble = borderStyle === 'double';
  const opacity = locked ? 0.5 : 1;

  const sharedProps = {
    fill: background,
    stroke: accent,
    strokeWidth: sw,
    strokeDasharray: dash,
    strokeLinecap: linecap,
    opacity,
  };

  let shape1: React.ReactElement;
  let shape2: React.ReactElement | null = null;
  let innerStroke: React.ReactElement | null = null;

  const ry = shape === 'oval' ? (size / 2 - pad) * 0.88 : undefined;
  const rx = size / 2 - pad;
  const innerPad = pad + sw * 2.5;

  switch (shape) {
    case 'oval':
      shape1 = <Ellipse cx={cx} cy={cy} rx={rx} ry={ry ?? rx} {...sharedProps} />;
      if (isDouble)
        innerStroke = <Ellipse cx={cx} cy={cy} rx={rx - sw * 2.5} ry={(ry ?? rx) - sw * 2.5} fill="none" stroke={accent} strokeWidth={sw * 0.7} opacity={opacity * 0.6} />;
      break;
    case 'round':
      shape1 = <Circle cx={cx} cy={cy} r={rx} {...sharedProps} />;
      if (isDouble)
        innerStroke = <Circle cx={cx} cy={cy} r={rx - sw * 2.5} fill="none" stroke={accent} strokeWidth={sw * 0.7} opacity={opacity * 0.6} />;
      break;
    case 'hexagon': {
      const pts = hexPoints(cx, cy, rx);
      const innerPts = hexPoints(cx, cy, rx - sw * 2.5);
      shape1 = <Polygon points={pts} {...sharedProps} />;
      if (isDouble)
        innerStroke = <Polygon points={innerPts} fill="none" stroke={accent} strokeWidth={sw * 0.7} opacity={opacity * 0.6} />;
      break;
    }
    case 'rect':
    default: {
      const rn = Math.min(8, size * 0.1);
      shape1 = <Rect x={pad} y={pad} width={size - pad * 2} height={size - pad * 2} rx={rn} {...sharedProps} />;
      if (isDouble)
        innerStroke = <Rect x={innerPad} y={innerPad} width={size - innerPad * 2} height={size - innerPad * 2} rx={Math.max(2, rn - 4)} fill="none" stroke={accent} strokeWidth={sw * 0.7} opacity={opacity * 0.6} />;
      break;
    }
  }

  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {pattern === 'radial' && (
        <Defs>
          <RadialGradient id={`rg${size}`} cx="50%" cy="40%" rx="60%" ry="60%">
            <Stop offset="0%" stopColor={accent} stopOpacity={0.12} />
            <Stop offset="100%" stopColor={accent} stopOpacity={0} />
          </RadialGradient>
        </Defs>
      )}
      {shape1}
      {innerStroke}
      {/* Pattern overlay rendered separately with clip */}
      {pattern !== 'radial' && pattern !== 'solid' && (
        <PatternOverlay size={size} pattern={pattern} accent={accent} />
      )}
    </Svg>
  );
}
