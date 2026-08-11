/**
 * PassportHighlightsStrip — Travel highlights in passport document style.
 * Shows highlight circles as travel-memory bubbles. Wraps existing highlight
 * viewer/composer behaviour — no backend logic changes.
 */
import React from 'react';
import {
  View, Text, Pressable, StyleSheet, ScrollView,
} from 'react-native';
import { Plus } from 'lucide-react-native';
import { PP, PP_LABEL } from '../../theme/passportTokens.ts';
import { DisplayMediaImage } from '../ui/DisplayMediaImage.tsx';

interface Highlight {
  id: string;
  thumbnailUrl?: string | null;
  mediaUrl?: string | null;
  caption?: string | null;
}

interface Props {
  highlights: Highlight[];
  hasActive: boolean;
  allViewed: boolean;
  isOwner?: boolean;
  onHighlightPress?: (index: number) => void;
  onAddHighlight?: () => void;
}

const BUBBLE_SIZE = 62;
const RING_WIDTH = 2;
const RING_GAP = 2;
const OUTER = BUBBLE_SIZE + (RING_WIDTH + RING_GAP) * 2;

function HighlightBubble({
  highlight,
  isUnviewed,
  onPress,
}: {
  highlight: Highlight;
  isUnviewed: boolean;
  onPress?: () => void;
}) {
  const src = highlight.thumbnailUrl ?? highlight.mediaUrl ?? null;
  return (
    <Pressable
      style={({ pressed }) => [b.outer, pressed && { opacity: 0.8 }]}
      onPress={onPress}
      accessibilityLabel="View highlight"
    >
      {/* Ring */}
      <View style={[b.ring, isUnviewed ? b.ringActive : b.ringViewed]} />
      {/* Bubble — src is post-media, a private bucket, so it must go through
          the signed-URL hydration layer (DisplayMediaImage/useHydratedMedia)
          rather than binding straight to <Image>. */}
      <View style={b.bubble}>
        <DisplayMediaImage
          uri={src}
          width={BUBBLE_SIZE}
          height={BUBBLE_SIZE}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          fallback={<View style={[StyleSheet.absoluteFill, b.placeholderBg]} />}
          testID="highlight-bubble-image"
        />
      </View>
    </Pressable>
  );
}

function AddBubble({ onPress }: { onPress?: () => void }) {
  return (
    <Pressable style={b.addOuter} onPress={onPress} accessibilityLabel="Add highlight">
      <View style={b.addBubble}>
        <Plus size={22} color={PP.inkMuted} strokeWidth={1.8} />
      </View>
    </Pressable>
  );
}

export function PassportHighlightsStrip({
  highlights, hasActive, allViewed, isOwner, onHighlightPress, onAddHighlight,
}: Props) {
  const hasAny = highlights.length > 0;

  if (!hasAny && !isOwner) return null;

  return (
    <View style={s.section}>
      <View style={s.header}>
        <Text style={s.sectionTitle}>TRAVEL HIGHLIGHTS</Text>
        {hasAny ? (
          <Text style={s.count}>{highlights.length}</Text>
        ) : null}
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.rail}
      >
        {/* Existing highlights */}
        {highlights.map((h, i) => (
          <HighlightBubble
            key={h.id}
            highlight={h}
            isUnviewed={hasActive && !allViewed}
            onPress={() => onHighlightPress?.(i)}
          />
        ))}

        {/* Add new (owner only) */}
        {isOwner ? (
          <AddBubble onPress={onAddHighlight} />
        ) : null}

        {/* Empty state for owner with no highlights */}
        {isOwner && !hasAny ? (
          <View style={s.emptyHint}>
            <Text style={s.emptyText}>
              Share travel moments as highlights — they expire in 3–48 hours
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const b = StyleSheet.create({
  outer: {
    width: OUTER, height: OUTER,
    alignItems: 'center', justifyContent: 'center',
  },
  ring: {
    position: 'absolute',
    width: OUTER, height: OUTER,
    borderRadius: OUTER / 2,
    borderWidth: RING_WIDTH,
  },
  ringActive: { borderColor: PP.gold },
  ringViewed: { borderColor: PP.borderLight },
  bubble: {
    width: BUBBLE_SIZE, height: BUBBLE_SIZE,
    borderRadius: BUBBLE_SIZE / 2,
    overflow: 'hidden',
    borderWidth: 2, borderColor: PP.paper,
    backgroundColor: PP.paperDeep,
  },
  placeholderBg: { backgroundColor: PP.paperDeep },

  addOuter: {
    width: OUTER, height: OUTER,
    alignItems: 'center', justifyContent: 'center',
  },
  addBubble: {
    width: BUBBLE_SIZE, height: BUBBLE_SIZE,
    borderRadius: BUBBLE_SIZE / 2,
    borderWidth: 1.5, borderColor: PP.borderLight, borderStyle: 'dashed',
    backgroundColor: PP.paperDeep,
    alignItems: 'center', justifyContent: 'center',
  },
});

const s = StyleSheet.create({
  section: { paddingBottom: 4 },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, marginBottom: 10,
  },
  sectionTitle: { ...PP_LABEL, fontSize: 10, letterSpacing: 2, color: PP.ink },
  count: {
    backgroundColor: PP.paperDeep,
    borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2,
    fontFamily: 'Courier', fontSize: 9, color: PP.inkMuted,
    overflow: 'hidden',
  },
  rail: {
    paddingLeft: 16, paddingRight: 16,
    gap: 10, alignItems: 'center',
  },
  emptyHint: {
    width: 200,
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 8,
  },
  emptyText: {
    fontSize: 12, color: PP.inkMuted,
    textAlign: 'center', lineHeight: 16,
  },
});
