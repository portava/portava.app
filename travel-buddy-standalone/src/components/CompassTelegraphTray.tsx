/**
 * CompassTelegraphTray — bottom sheet for the Ask Compass chip in Telegraph.
 *
 * Shows up to 4 Compass recommendation cards relevant to the current chat
 * thread. Each card has a "Share to chat" button that the user must tap
 * explicitly to send the card as a message — no card is sent automatically.
 *
 * Privacy: the tray calls the backend telegraph surface endpoint; the backend
 * filters to public-only items accessible to all thread participants.
 *
 * Empty state: "No suggestions right now" with a dismiss button — no fake cards.
 * Unavailable state (flag off or error): shows a brief notice and dismisses.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  Image,
} from 'react-native';
import { CachedImage } from './CachedImage.tsx';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Compass, X, MapPin, Send, Zap } from 'lucide-react-native';
import { color, space, radius, type as t, avatar } from '../theme/tokens.ts';
import { fetchCompassTelegraphCards, type CompassTelegraphCard } from '../services/compass.ts';

const TYPE_LABELS: Record<string, string> = {
  event:      'Event',
  place:      'Place',
  hidden_gem: 'Hidden Gem',
  activity:   'Activity',
};

function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type.charAt(0).toUpperCase() + type.slice(1);
}

function typeColor(type: string): string {
  switch (type) {
    case 'event':      return '#2B5EA7';
    case 'hidden_gem': return '#7A4C20';
    case 'place':      return '#0A3D4A';
    case 'activity':   return '#4B3A8C';
    default:           return color.signal;
  }
}

function typeBg(type: string): string {
  switch (type) {
    case 'event':      return '#E6EEF8';
    case 'hidden_gem': return '#F2EBE0';
    case 'place':      return '#E0EFEC';
    case 'activity':   return '#EDE8F6';
    default:           return color.signal + '18';
  }
}

export interface CompassTelegraphTrayProps {
  visible:     boolean;
  threadId:    string;
  onDismiss:   () => void;
  onShareCard: (card: CompassTelegraphCard) => void;
}

export function CompassTelegraphTray({
  visible,
  threadId,
  onDismiss,
  onShareCard,
}: CompassTelegraphTrayProps) {
  const insets = useSafeAreaInsets();
  const [cards, setCards]           = useState<CompassTelegraphCard[]>([]);
  const [city, setCity]             = useState<string | null>(null);
  const [loading, setLoading]       = useState(false);
  const [sharedId, setSharedId]     = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!threadId) return;
    setLoading(true);
    setCards([]);
    setCity(null);
    try {
      const result = await fetchCompassTelegraphCards(threadId);
      if (result.ok && result.cards) {
        setCards(result.cards);
        setCity(result.city ?? null);
      }
    } finally {
      setLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    if (visible) {
      setSharedId(null);
      setSelectedId(null);
      load();
    }
  }, [visible, load]);

  function handleShare(card: CompassTelegraphCard) {
    setSharedId(card.id);
    onShareCard(card);
    setTimeout(() => {
      onDismiss();
    }, 300);
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onDismiss}
    >
      <Pressable style={s.overlay} onPress={onDismiss} />
      <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom + space.md, space.xl) }]}>
        <View style={s.handle} />

        {/* Header */}
        <View style={s.header}>
          <View style={s.headerLeft}>
            <View style={s.headerIcon}>
              <Compass size={14} color={color.onInk} />
            </View>
            <View>
              <Text style={s.title}>Ask Compass</Text>
              {city ? (
                <View style={s.cityRow}>
                  <MapPin size={11} color={color.faint} />
                  <Text style={s.cityLabel}>{city}</Text>
                </View>
              ) : null}
            </View>
          </View>
          <Pressable style={s.closeBtn} onPress={onDismiss} hitSlop={8}>
            <X size={18} color={color.mute} />
          </Pressable>
        </View>

        <Text style={s.subtitle}>
          Tap a card to preview, then share it to the chat.
        </Text>

        {/* Content */}
        {loading ? (
          <View style={s.emptyWrap}>
            <ActivityIndicator size="small" color={color.signal} />
            <Text style={s.emptyText}>Finding suggestions…</Text>
          </View>
        ) : cards.length === 0 ? (
          <View style={s.emptyWrap}>
            <View style={s.emptyIcon}>
              <Zap size={22} color={color.faint} />
            </View>
            <Text style={s.emptyTitle}>No suggestions right now</Text>
            <Text style={s.emptyBody}>
              Compass couldn't find relevant recommendations for this chat. Try again later.
            </Text>
            <Pressable style={s.dismissBtn} onPress={onDismiss}>
              <Text style={s.dismissBtnText}>Dismiss</Text>
            </Pressable>
          </View>
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={s.cardList}
          >
            {cards.map((card) => (
              <CardRow
                key={card.id}
                card={card}
                isSelected={selectedId === card.id}
                isShared={sharedId === card.id}
                onSelect={() => setSelectedId(card.id)}
                onShare={handleShare}
              />
            ))}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

function CardRow({
  card,
  isSelected,
  isShared,
  onSelect,
  onShare,
}: {
  card:       CompassTelegraphCard;
  isSelected: boolean;
  isShared:   boolean;
  onSelect:   () => void;
  onShare:    (card: CompassTelegraphCard) => void;
}) {
  const tc = typeColor(card.type);
  const bg = typeBg(card.type);

  return (
    <Pressable
      style={[cr.card, isSelected && cr.cardSelected]}
      onPress={onSelect}
      accessibilityRole="button"
      accessibilityLabel={`Preview ${card.title ?? typeLabel(card.type)}`}
    >
      {/* Image (optional) */}
      {card.imageUrl ? (
        <CachedImage source={{ uri: card.imageUrl }} style={cr.image} resizeMode="cover" />
      ) : (
        <View style={[cr.imageFallback, { backgroundColor: bg }]}>
          <Compass size={22} color={tc} />
        </View>
      )}

      <View style={cr.body}>
        <View style={cr.topRow}>
          <View style={[cr.typeBadge, { backgroundColor: bg }]}>
            <Text style={[cr.typeText, { color: tc }]}>{typeLabel(card.type)}</Text>
          </View>
          {card.city ? (
            <View style={cr.cityChip}>
              <MapPin size={9} color={color.faint} />
              <Text style={cr.cityText} numberOfLines={1}>{card.city}</Text>
            </View>
          ) : null}
        </View>

        <Text style={cr.title} numberOfLines={2}>
          {card.title ?? card.category ?? typeLabel(card.type)}
        </Text>

        {card.description ? (
          <Text style={cr.desc} numberOfLines={isSelected ? undefined : 2}>{card.description}</Text>
        ) : null}

        {isSelected && (
          <Pressable
            style={[cr.shareBtn, isShared && cr.shareBtnSent]}
            onPress={() => onShare(card)}
            disabled={isShared}
          >
            <Send size={13} color={isShared ? color.mute : color.onInk} />
            <Text style={[cr.shareBtnText, isShared && cr.shareBtnTextSent]}>
              {isShared ? 'Shared' : 'Share to chat'}
            </Text>
          </Pressable>
        )}
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.38)',
  },
  sheet: {
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: space.sm,
    paddingHorizontal: space.lg,
    maxHeight: '80%',
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.haze,
    alignSelf: 'center',
    marginBottom: space.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  headerIcon: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    ...t.bodyStrong,
    color: color.ink,
    fontWeight: '700',
    fontSize: 16,
  },
  cityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginTop: 1,
  },
  cityLabel: {
    ...t.small,
    color: color.faint,
    fontSize: 11,
  },
  closeBtn: {
    padding: 4,
  },
  subtitle: {
    ...t.small,
    color: color.mute,
    fontSize: 12,
    marginBottom: space.md,
  },
  emptyWrap: {
    alignItems: 'center',
    paddingVertical: space.xl,
    gap: space.sm,
  },
  emptyIcon: {
    width: avatar.lgXl, height: avatar.lgXl,
    borderRadius: avatar.lgXl / 2,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  emptyTitle: {
    ...t.bodyStrong,
    color: color.ink,
    fontWeight: '600',
  },
  emptyText: {
    ...t.small,
    color: color.mute,
    marginTop: space.sm,
  },
  emptyBody: {
    ...t.small,
    color: color.mute,
    textAlign: 'center',
    lineHeight: 18,
    paddingHorizontal: space.lg,
  },
  dismissBtn: {
    marginTop: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
  },
  dismissBtnText: {
    ...t.body,
    color: color.mute,
  },
  cardList: {
    gap: space.sm,
    paddingBottom: space.sm,
  },
});

const cr = StyleSheet.create({
  card: {
    flexDirection: 'row',
    gap: space.sm,
    backgroundColor: color.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    overflow: 'hidden',
  },
  cardSelected: {
    borderColor: color.signal,
    backgroundColor: color.paper,
  },
  image: {
    width: 72,
    height: 90,
  },
  imageFallback: {
    width: 72,
    height: 90,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    flex: 1,
    paddingVertical: space.sm,
    paddingRight: space.sm,
    gap: 4,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    flexWrap: 'wrap',
  },
  typeBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  typeText: {
    ...t.stamp,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  cityChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  cityText: {
    ...t.stamp,
    fontSize: 10,
    color: color.faint,
  },
  title: {
    ...t.bodyStrong,
    color: color.ink,
    fontWeight: '600',
    fontSize: 13,
    lineHeight: 18,
  },
  desc: {
    ...t.small,
    color: color.mute,
    fontSize: 11,
    lineHeight: 15,
  },
  shareBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    marginTop: 2,
    backgroundColor: color.signal,
    paddingHorizontal: space.sm,
    paddingVertical: 5,
    borderRadius: radius.pill,
  },
  shareBtnSent: {
    backgroundColor: color.haze,
  },
  shareBtnText: {
    ...t.small,
    color: color.onInk,
    fontWeight: '600',
    fontSize: 11,
  },
  shareBtnTextSent: {
    color: color.mute,
  },
});
