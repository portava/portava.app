/**
 * PassportVerifiedSeal — circular rubber-stamp VERIFIED PASSPORT seal.
 * Only renders when status === 'verified'. Returns null otherwise.
 * Designed to be overlaid (absolute position, slight rotation) on the identity card.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { ShieldCheck } from 'lucide-react-native';
import { PP, PP_LABEL, fmtMonthYear } from '../../theme/passportTokens.ts';

interface Props {
  status: string;
  verifiedSince?: string | null;
  size?: number;
}

export function PassportVerifiedSeal({ status, verifiedSince, size = 92 }: Props) {
  if (status !== 'verified') return null;

  const inner = size * 0.82;
  const iconSize = size * 0.28;

  return (
    <View style={[s.wrap, { width: size, height: size }]}>
      {/* Outer circle */}
      <View style={[s.outerRing, { width: size, height: size, borderRadius: size / 2 }]} />
      {/* Inner circle */}
      <View style={[s.innerRing, {
        width: inner, height: inner, borderRadius: inner / 2,
        top: (size - inner) / 2, left: (size - inner) / 2,
      }]} />
      {/* Content */}
      <View style={[StyleSheet.absoluteFill, s.content]}>
        <Text style={[s.arcTop, { fontSize: size * 0.085 }]}>VERIFIED</Text>
        <ShieldCheck size={iconSize} color={PP.seal} strokeWidth={1.8} />
        <Text style={[s.arcBottom, { fontSize: size * 0.08 }]}>PASSPORT</Text>
        {verifiedSince ? (
          <Text style={[s.since, { fontSize: size * 0.07 }]}>
            {fmtMonthYear(verifiedSince)}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PP.sealLight,
  },
  outerRing: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: PP.seal,
    backgroundColor: 'transparent',
  },
  innerRing: {
    position: 'absolute',
    borderWidth: 1,
    borderColor: PP.seal,
    borderStyle: 'dashed',
    backgroundColor: 'transparent',
  },
  content: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
    paddingHorizontal: 6,
  },
  arcTop: {
    ...PP_LABEL,
    fontSize: 8,
    color: PP.seal,
    letterSpacing: 2.5,
    textAlign: 'center',
  },
  arcBottom: {
    ...PP_LABEL,
    fontSize: 7.5,
    color: PP.seal,
    letterSpacing: 2,
    textAlign: 'center',
  },
  since: {
    fontFamily: 'Courier',
    fontSize: 7,
    color: PP.seal,
    opacity: 0.75,
    letterSpacing: 0.8,
    marginTop: 1,
  },
});
