/**
 * WatchRadialMenu — arc quick-menu triggered by long-pressing the video body.
 *
 * Four actions fanning in an arc:
 *   Save Gem · Add to Trip · Share to Telegraph · Find here
 *
 * Animates in with a scale + opacity spring. Auto-dismisses after 4 s.
 * Each action tap routes to the appropriate flow and dismisses the menu.
 */
import React, { useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  Pressable,
  Animated,
  StyleSheet,
  Dimensions,
} from 'react-native';
import { Gem, MapPinned, Megaphone, SearchCheck } from 'lucide-react-native';
import { color, radius, type as t, avatar, dot} from '../../theme/tokens.ts';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// Arc layout: 4 items spread over ~135° centred pointing up-left from screen centre
// Positions relative to the anchor (screen centre)
const ARC_RADIUS = 90;
const ARC_ITEMS: Array<{
  key: string;
  label: string;
  angleDeg: number;
  bgColor: string;
  icon: (size: number, col: string) => React.ReactNode;
}> = [
  {
    key: 'gem',
    label: 'Save Gem',
    angleDeg: 210,
    bgColor: '#8B5CF6',
    icon: (sz, col) => <Gem size={sz} color={col} />,
  },
  {
    key: 'trip',
    label: 'Add to Trip',
    angleDeg: 255,
    bgColor: color.signal,
    icon: (sz, col) => <MapPinned size={sz} color={col} />,
  },
  {
    key: 'telegraph',
    label: 'Telegraph',
    angleDeg: 300,
    bgColor: '#0EA5E9',
    icon: (sz, col) => <Megaphone size={sz} color={col} />,
  },
  {
    key: 'find',
    label: 'Find here',
    angleDeg: 345,
    bgColor: '#10B981',
    icon: (sz, col) => <SearchCheck size={sz} color={col} />,
  },
];

function degToRad(deg: number) {
  return (deg * Math.PI) / 180;
}

export interface WatchRadialMenuProps {
  visible: boolean;
  onDismiss: () => void;
  onSaveGem: () => void;
  onAddToTrip: () => void;
  onShareTelegraph: () => void;
  onFindHere: () => void;
}

export function WatchRadialMenu({
  visible,
  onDismiss,
  onSaveGem,
  onAddToTrip,
  onShareTelegraph,
  onFindHere,
}: WatchRadialMenuProps) {
  const scaleAnim   = useRef(new Animated.Value(0)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;
  const autoDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = useCallback(() => {
    if (autoDismissTimer.current) {
      clearTimeout(autoDismissTimer.current);
      autoDismissTimer.current = null;
    }
    Animated.parallel([
      Animated.timing(scaleAnim, { toValue: 0, duration: 160, useNativeDriver: true }),
      Animated.timing(opacityAnim, { toValue: 0, duration: 160, useNativeDriver: true }),
    ]).start(() => onDismiss());
  }, [scaleAnim, opacityAnim, onDismiss]);

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(scaleAnim, {
          toValue: 1,
          friction: 5,
          tension: 200,
          useNativeDriver: true,
        }),
        Animated.timing(opacityAnim, {
          toValue: 1,
          duration: 180,
          useNativeDriver: true,
        }),
      ]).start();
      // Auto-dismiss after 4 s
      autoDismissTimer.current = setTimeout(() => {
        dismiss();
      }, 4000);
    } else {
      scaleAnim.setValue(0);
      opacityAnim.setValue(0);
    }
    return () => {
      if (autoDismissTimer.current) clearTimeout(autoDismissTimer.current);
    };
  }, [visible, scaleAnim, opacityAnim, dismiss]);

  if (!visible) return null;

  const callbacks: Record<string, () => void> = {
    gem: onSaveGem,
    trip: onAddToTrip,
    telegraph: onShareTelegraph,
    find: onFindHere,
  };

  // Anchor: slightly above vertical centre
  const anchorX = SCREEN_W / 2;
  const anchorY = SCREEN_H * 0.52;

  return (
    // Full-screen backdrop (tap to dismiss)
    <Pressable
      style={StyleSheet.absoluteFill}
      onPress={dismiss}
      accessibilityRole="button"
      accessibilityLabel="Close menu"
    >
      <Animated.View
        style={[
          s.container,
          { opacity: opacityAnim, transform: [{ scale: scaleAnim }] },
        ]}
        pointerEvents="box-none"
      >
        {/* Centre hub */}
        <View
          style={[
            s.hub,
            { left: anchorX - 22, top: anchorY - 22 },
          ]}
        >
          <View style={s.hubInner} />
        </View>

        {/* Arc items */}
        {ARC_ITEMS.map((item) => {
          const rad = degToRad(item.angleDeg);
          const x = anchorX + ARC_RADIUS * Math.cos(rad) - 28;
          const y = anchorY + ARC_RADIUS * Math.sin(rad) - 28;
          return (
            <Pressable
              key={item.key}
              style={[
                s.arcBtn,
                { left: x, top: y, backgroundColor: item.bgColor },
              ]}
              onPress={(e) => {
                e.stopPropagation();
                dismiss();
                callbacks[item.key]?.();
              }}
              accessibilityRole="button"
              accessibilityLabel={item.label}
            >
              {item.icon(18, '#fff')}
              <Text style={s.arcLabel}>{item.label}</Text>
            </Pressable>
          );
        })}
      </Animated.View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  hub: {
    position: 'absolute',
    width: avatar.lgXl, height: avatar.lgXl,
    borderRadius: avatar.lgXl / 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  hubInner: {
    width: dot.lg,
    height: dot.lg,
    borderRadius: dot.lg / 2,
    backgroundColor: '#fff',
  },
  arcBtn: {
    position: 'absolute',
    width: avatar.xxl, height: avatar.xxl,
    borderRadius: avatar.xxl / 2,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  arcLabel: {
    ...t.stamp,
    color: '#fff',
    fontSize: 8,
    fontWeight: '700',
    textAlign: 'center',
    lineHeight: 10,
  },
});
