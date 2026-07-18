import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  Pressable,
  Animated,
  AccessibilityInfo,
  StyleSheet,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { router } from 'expo-router';
import { Send, MapPin } from 'lucide-react-native';
import { color, space, radius, type as t } from '../theme/tokens.ts';

/* ── Local palette ─────────────────────────────────────────── */
const p = {
  cream: '#FAF6EF',
  creamDeep: '#F0EAE0',
  creamEdge: '#E0D5C5',
  stampBlue: '#DDE9F5',
  stampRed: '#F5E6DF',
  stampGreen: '#DDF0E6',
  cancelInk: '#9E8B7A',
  sky: '#A8CEE8',
  skyGlow: '#F5C97A',
  mountain: '#4A6A5C',
  mountainFar: '#6B8C7E',
  ground: '#3D5A47',
  sun: '#F9B84A',
  doodleInk: '#B8A898',
  photoA: '#C8DEC8',
  photoB: '#C8D4E8',
  photoC: '#E8D4C0',
  photoD: '#E0C8D8',
  stickyYellow: '#FFF9C8',
  stickyLine: '#EDE89A',
};

/* ── Sub-components ────────────────────────────────────────── */

function StampCell({
  bg,
  emoji,
  label,
  size,
}: {
  bg: string;
  emoji: string;
  label: string;
  size: number;
}) {
  return (
    <View
      style={[
        st.stamp,
        {
          width: size,
          height: size * 1.15,
          backgroundColor: bg,
        },
      ]}
    >
      <Text style={[st.stampEmoji, { fontSize: size * 0.32 }]}>{emoji}</Text>
      <Text style={[st.stampLabel, { fontSize: size * 0.14 }]}>{label}</Text>
    </View>
  );
}

function PostmarkCancel({ size }: { size: number }) {
  return (
    <View style={[st.postmark, { width: size, height: size }]}>
      {/* concentric rings */}
      <View
        style={[
          st.ring,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            borderColor: p.cancelInk,
          },
        ]}
      />
      <View
        style={[
          st.ring,
          {
            width: size * 0.72,
            height: size * 0.72,
            borderRadius: size * 0.36,
            borderColor: p.cancelInk,
            top: size * 0.14,
            left: size * 0.14,
          },
        ]}
      />
      {/* crossed dashes */}
      <View
        style={[
          st.dash,
          {
            width: size * 0.65,
            top: size * 0.49,
            left: size * 0.175,
            backgroundColor: p.cancelInk,
            transform: [{ rotate: '20deg' }],
          },
        ]}
      />
      <View
        style={[
          st.dash,
          {
            width: size * 0.65,
            top: size * 0.52,
            left: size * 0.175,
            backgroundColor: p.cancelInk,
            transform: [{ rotate: '-20deg' }],
          },
        ]}
      />
    </View>
  );
}

function MountainTriangle({
  col,
  w,
  h,
  left,
  bottom,
}: {
  col: string;
  w: number;
  h: number;
  left: number;
  bottom: number;
}) {
  /* Border-trick triangle — works on RN Web and native */
  return (
    <View
      style={{
        position: 'absolute',
        left,
        bottom,
        width: 0,
        height: 0,
        borderLeftWidth: w / 2,
        borderRightWidth: w / 2,
        borderBottomWidth: h,
        borderLeftColor: 'transparent',
        borderRightColor: 'transparent',
        borderBottomColor: col,
      }}
    />
  );
}

/* ── Main component ────────────────────────────────────────── */

export function PostcardEmptyState({
  isOwner,
  onAddPostcard,
}: {
  isOwner: boolean;
  onAddPostcard?: () => void;
}) {
  const { width } = useWindowDimensions();
  const cardWidth = Math.min(width - 48, 320);

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(18)).current;

  useEffect(() => {
    let cancelled = false;

    const run = (skip: boolean) => {
      if (cancelled) return;
      if (skip) {
        fadeAnim.setValue(1);
        slideAnim.setValue(0);
      } else {
        Animated.parallel([
          Animated.timing(fadeAnim, {
            toValue: 1,
            duration: 400,
            useNativeDriver: true,
          }),
          Animated.timing(slideAnim, {
            toValue: 0,
            duration: 400,
            useNativeDriver: true,
          }),
        ]).start();
      }
    };

    if (Platform.OS === 'web') {
      run(false);
    } else {
      AccessibilityInfo.isReduceMotionEnabled().then((reduced) => run(reduced));
    }

    return () => {
      cancelled = true;
    };
  }, [fadeAnim, slideAnim]);

  /* Dimensions derived from cardWidth */
  const sceneH = Math.round(cardWidth * 0.46);
  const stampSz = Math.round(cardWidth * 0.165);
  const postmarkSz = Math.round(cardWidth * 0.13);

  const handleCTA = () => {
    if (onAddPostcard) {
      onAddPostcard();
    } else {
      router.push('/create' as any);
    }
  };

  return (
    <Animated.View
      style={[
        es.root,
        {
          opacity: fadeAnim,
          transform: [{ translateY: slideAnim }],
        },
      ]}
    >
      {/* ── Card ─────────────────────────────────────────── */}
      <View style={[es.card, { width: cardWidth, backgroundColor: p.cream }]}>

        {/* Top colour band with dots */}
        <View style={[es.topBand, { backgroundColor: color.signal }]}>
          {Array.from({ length: 8 }).map((_, i) => (
            <View key={i} style={es.bandDot} />
          ))}
        </View>

        {/* Stamps row */}
        <View style={es.stampsRow}>
          <StampCell bg={p.stampBlue} emoji="✈️" label="AIR MAIL" size={stampSz} />
          <StampCell bg={p.stampRed} emoji="🗺️" label="TRAVEL" size={stampSz} />
          <StampCell bg={p.stampGreen} emoji="📍" label="PLACES" size={stampSz} />
          <PostmarkCancel size={postmarkSz} />
        </View>

        {/* ── Landscape scene ──────────────────────────── */}
        <View
          style={[
            es.scene,
            {
              height: sceneH,
              backgroundColor: p.sky,
              marginHorizontal: 12,
              borderRadius: 6,
            },
          ]}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          aria-hidden
        >
          {/* Inner frame border */}
          <View style={es.sceneFrame} />

          {/* Sunset glow strip */}
          <View
            style={[
              es.skyGlow,
              {
                height: sceneH * 0.28,
                backgroundColor: p.skyGlow,
                opacity: 0.55,
              },
            ]}
          />

          {/* Sun disc */}
          <View
            style={[
              es.sun,
              {
                width: sceneH * 0.22,
                height: sceneH * 0.22,
                borderRadius: sceneH * 0.11,
                backgroundColor: p.sun,
                right: cardWidth * 0.12,
                top: sceneH * 0.08,
              },
            ]}
          />

          {/* Far mountains */}
          <MountainTriangle
            col={p.mountainFar}
            w={sceneH * 0.9}
            h={sceneH * 0.42}
            left={-sceneH * 0.04}
            bottom={sceneH * 0.18}
          />
          <MountainTriangle
            col={p.mountainFar}
            w={sceneH * 0.7}
            h={sceneH * 0.34}
            left={sceneH * 0.55}
            bottom={sceneH * 0.18}
          />

          {/* Near mountains */}
          <MountainTriangle
            col={p.mountain}
            w={sceneH * 0.75}
            h={sceneH * 0.5}
            left={sceneH * 0.08}
            bottom={sceneH * 0.12}
          />
          <MountainTriangle
            col={p.mountain}
            w={sceneH * 0.55}
            h={sceneH * 0.38}
            left={sceneH * 0.62}
            bottom={sceneH * 0.12}
          />

          {/* Ground strip */}
          <View
            style={[
              es.ground,
              {
                height: sceneH * 0.16,
                backgroundColor: p.ground,
              },
            ]}
          />

          {/* Camera chip — top left */}
          <View style={es.cameraChip}>
            <Text style={es.cameraChipText}>📷</Text>
          </View>

          {/* Location pin chip — bottom centre */}
          <View style={es.pinChip}>
            <MapPin size={10} color={color.signal} strokeWidth={2.2} />
            <Text style={es.pinChipText}>Your journey</Text>
          </View>

          {/* Paper-plane route dashes */}
          <View
            style={[
              es.routeDash,
              {
                width: cardWidth * 0.22,
                top: sceneH * 0.22,
                left: cardWidth * 0.08,
                transform: [{ rotate: '-18deg' }],
              },
            ]}
          />
          <View
            style={[
              es.routeDash,
              {
                width: cardWidth * 0.18,
                top: sceneH * 0.14,
                left: cardWidth * 0.29,
                transform: [{ rotate: '-12deg' }],
              },
            ]}
          />
          <View style={[es.planIcon, { top: sceneH * 0.08, left: cardWidth * 0.46 }]}>
            <Send size={14} color={p.doodleInk} strokeWidth={1.8} style={{ transform: [{ rotate: '-30deg' }] }} />
          </View>
        </View>

        {/* ── Sticky note + photo strip row ────────────── */}
        <View style={es.notesRow}>
          {/* Sticky note */}
          <View
            style={[
              es.sticky,
              {
                backgroundColor: p.stickyYellow,
                transform: [{ rotate: '-2.5deg' }],
              },
            ]}
          >
            {/* Rule lines */}
            {[0, 1, 2].map((i) => (
              <View
                key={i}
                style={[es.stickyRule, { backgroundColor: p.stickyLine, marginTop: i === 0 ? 4 : 5 }]}
              />
            ))}
            <Text style={es.stickyText}>wish you{'\n'}were here</Text>
          </View>

          {/* Mini photo strip */}
          <View style={es.photoStrip}>
            {[p.photoA, p.photoB, p.photoC, p.photoD].map((col, i) => (
              <View key={i} style={[es.photo, { backgroundColor: col }]}>
                <MapPin size={8} color="rgba(0,0,0,0.18)" strokeWidth={1.6} />
              </View>
            ))}
          </View>
        </View>

        {/* Bottom cream depth edge */}
        <View style={[es.depthEdge, { backgroundColor: p.creamEdge }]} />
      </View>

      {/* ── Copy & CTA ───────────────────────────────────── */}
      <View style={es.copy}>
        <Text
          style={es.headline}
          accessibilityRole="header"
        >
          {isOwner ? 'Your adventure starts here' : 'No postcards yet'}
        </Text>
        <Text style={es.subtext}>
          {isOwner
            ? 'No postcards yet. Every journey has a first moment.'
            : "This traveler hasn't shared a public postcard yet."}
        </Text>
        {isOwner && (
          <Text style={es.tagline}>Share a place. Start a story. Inspire others.</Text>
        )}
      </View>

      {isOwner && (
        <Pressable
          style={es.cta}
          onPress={handleCTA}
          accessibilityRole="button"
          accessibilityLabel="Post your first postcard"
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
        >
          <Text style={es.ctaText}>Post your first postcard</Text>
        </Pressable>
      )}
    </Animated.View>
  );
}

/* ── Styles ────────────────────────────────────────────────── */
const es = StyleSheet.create({
  root: {
    paddingHorizontal: 24,
    paddingTop: space.xxxl,
    paddingBottom: space.xl,
    alignItems: 'center',
    gap: space.lg,
  },

  /* Card shell */
  card: {
    borderRadius: 10,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.10,
    shadowRadius: 8,
    elevation: 3,
  },

  /* Top band */
  topBand: {
    height: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingHorizontal: 6,
  },
  bandDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.7)',
  },

  /* Stamps row */
  stampsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 6,
    gap: 6,
  },

  /* Stamp cell */
  stamp: {
    borderRadius: 3,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
  },
  stampEmoji: { lineHeight: undefined },
  stampLabel: { fontWeight: '700', color: '#9E8B7A', letterSpacing: 0.4 },

  /* Postmark */
  postmark: { position: 'relative' },
  ring: {
    position: 'absolute',
    borderWidth: 1.2,
    top: 0,
    left: 0,
  },
  dash: {
    position: 'absolute',
    height: 1.5,
    borderRadius: 1,
  },

  /* Scene */
  scene: {
    overflow: 'hidden',
    position: 'relative',
  },
  sceneFrame: {
    position: 'absolute',
    top: 3,
    left: 3,
    right: 3,
    bottom: 3,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    zIndex: 10,
  },
  skyGlow: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  },
  sun: {
    position: 'absolute',
  },
  ground: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  },

  /* Camera chip */
  cameraChip: {
    position: 'absolute',
    top: 7,
    left: 7,
    backgroundColor: 'rgba(255,255,255,0.72)',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
    zIndex: 5,
  },
  cameraChipText: { fontSize: 11 },

  /* Pin chip */
  pinChip: {
    position: 'absolute',
    bottom: 7,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(255,255,255,0.82)',
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    zIndex: 5,
  },
  pinChipText: { fontSize: 9, fontWeight: '700', color: '#555' },

  /* Route dashes + plane */
  routeDash: {
    position: 'absolute',
    height: 1.5,
    borderRadius: 1,
    borderWidth: 1.2,
    borderColor: '#B8A898',
    borderStyle: 'dashed',
    backgroundColor: 'transparent',
  },
  planIcon: {
    position: 'absolute',
    zIndex: 5,
  },

  /* Notes row */
  notesRow: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
    alignItems: 'flex-start',
  },

  /* Sticky note */
  sticky: {
    flex: 1,
    borderRadius: 2,
    padding: 6,
    minHeight: 64,
    shadowColor: '#000',
    shadowOffset: { width: 1, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
    elevation: 1,
  },
  stickyRule: {
    height: 1,
    borderRadius: 0.5,
    marginBottom: 2,
  },
  stickyText: {
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    fontSize: 11,
    color: '#8B7D55',
    lineHeight: 15,
    marginTop: 4,
  },

  /* Photo strip */
  photoStrip: {
    flexDirection: 'row',
    gap: 4,
    alignItems: 'flex-start',
    flexWrap: 'wrap',
    flex: 1,
  },
  photo: {
    width: 30,
    height: 30,
    borderRadius: 3,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.06)',
  },

  /* Depth edge */
  depthEdge: {
    height: 4,
  },

  /* Copy block */
  copy: {
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: 8,
  },
  headline: {
    fontSize: 18,
    fontWeight: '700',
    color: '#3A2E22',
    textAlign: 'center',
  },
  subtext: {
    fontSize: 14,
    color: '#7A6A58',
    textAlign: 'center',
    lineHeight: 20,
  },
  tagline: {
    fontSize: 12,
    fontStyle: 'italic',
    color: '#A89880',
    textAlign: 'center',
    marginTop: 2,
  },

  /* CTA button */
  cta: {
    backgroundColor: color.signal,
    borderRadius: radius.pill,
    paddingHorizontal: space.xl,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#fff',
  },
});

/* Stamp sub-styles hoisted to avoid re-creation on each render */
const st = StyleSheet.create({
  stamp: {
    borderRadius: 3,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
  },
  stampEmoji: {},
  stampLabel: { fontWeight: '700', color: '#9E8B7A', letterSpacing: 0.4 },
  postmark: { position: 'relative' },
  ring: { position: 'absolute', borderWidth: 1.2, top: 0, left: 0 },
  dash: { position: 'absolute', height: 1.5, borderRadius: 1 },
});
