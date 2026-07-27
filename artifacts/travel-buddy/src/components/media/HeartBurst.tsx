/**
 * HeartBurst — multi-particle heart animation for Watch double-tap like.
 *
 * Shows a large centre heart that springs up and fades, plus 6 smaller
 * hearts that radiate outward at 60° intervals.  Triggered imperatively
 * via the HeartBurstHandle ref so the caller can fire it without needing
 * any state change.
 */

import React, {
  useRef,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from 'react';
import { Animated, StyleSheet, View } from 'react-native';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HeartBurstHandle {
  trigger(): void;
}

// ── Particle angles (60° apart) ───────────────────────────────────────────────

const ANGLES_DEG = [0, 60, 120, 180, 240, 300];

// ── Component ─────────────────────────────────────────────────────────────────

export const HeartBurst = forwardRef<HeartBurstHandle>(function HeartBurst(_, ref) {
  // Centre heart
  const centerScale   = useRef(new Animated.Value(0)).current;
  const centerOpacity = useRef(new Animated.Value(0)).current;

  // Six radial particles — each has translation X/Y, scale, opacity
  const particles = useRef(
    ANGLES_DEG.map(() => ({
      x:       new Animated.Value(0),
      y:       new Animated.Value(0),
      scale:   new Animated.Value(0),
      opacity: new Animated.Value(0),
    })),
  ).current;

  const trigger = useCallback(() => {
    // ── Centre heart ──────────────────────────────────────────────────
    centerScale.setValue(0);
    centerOpacity.setValue(0);
    Animated.parallel([
      Animated.sequence([
        Animated.spring(centerScale, {
          toValue: 1.15,
          useNativeDriver: true,
          speed: 22,
          bounciness: 14,
        }),
        Animated.timing(centerScale, {
          toValue: 1,
          duration: 80,
          useNativeDriver: true,
        }),
      ]),
      Animated.sequence([
        Animated.timing(centerOpacity, {
          toValue: 1,
          duration: 70,
          useNativeDriver: true,
        }),
        Animated.delay(380),
        Animated.timing(centerOpacity, {
          toValue: 0,
          duration: 260,
          useNativeDriver: true,
        }),
      ]),
    ]).start();

    // ── Radial particles ──────────────────────────────────────────────
    particles.forEach((p, i) => {
      const angleRad = (ANGLES_DEG[i] * Math.PI) / 180 - Math.PI / 2; // start from top
      // Alternate radii so particles don't all land at the same distance
      const dist = i % 2 === 0 ? 52 : 68;
      p.x.setValue(0);
      p.y.setValue(0);
      p.scale.setValue(0);
      p.opacity.setValue(0);

      Animated.parallel([
        // Fly outward
        Animated.timing(p.x, {
          toValue: Math.cos(angleRad) * dist,
          duration: 480,
          useNativeDriver: true,
        }),
        Animated.timing(p.y, {
          toValue: Math.sin(angleRad) * dist,
          duration: 480,
          useNativeDriver: true,
        }),
        // Pop up then shrink
        Animated.sequence([
          Animated.timing(p.scale, {
            toValue: 1,
            duration: 140,
            useNativeDriver: true,
          }),
          Animated.timing(p.scale, {
            toValue: 0.5,
            duration: 340,
            useNativeDriver: true,
          }),
        ]),
        // Fade in fast, hold, fade out
        Animated.sequence([
          Animated.timing(p.opacity, {
            toValue: 1,
            duration: 100,
            useNativeDriver: true,
          }),
          Animated.delay(220),
          Animated.timing(p.opacity, {
            toValue: 0,
            duration: 200,
            useNativeDriver: true,
          }),
        ]),
      ]).start();
    });
  }, [centerScale, centerOpacity, particles]);

  useImperativeHandle(ref, () => ({ trigger }), [trigger]);

  return (
    <View style={s.root} pointerEvents="none">
      {/* Radial particles */}
      {particles.map((p, i) => (
        <Animated.Text
          key={i}
          style={[
            s.particle,
            {
              opacity: p.opacity,
              transform: [
                { translateX: p.x },
                { translateY: p.y },
                { scale: p.scale },
              ],
            },
          ]}
        >
          ❤️
        </Animated.Text>
      ))}

      {/* Centre heart (renders on top of particles) */}
      <Animated.Text
        style={[
          s.center,
          {
            opacity: centerOpacity,
            transform: [{ scale: centerScale }],
          },
        ]}
      >
        ❤️
      </Animated.Text>
    </View>
  );
});

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: {
    position: 'absolute',
    top: '30%',
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: {
    fontSize: 80,
    // particles are position:absolute so they don't push the centre heart
  },
  particle: {
    position: 'absolute',
    fontSize: 22,
  },
});
