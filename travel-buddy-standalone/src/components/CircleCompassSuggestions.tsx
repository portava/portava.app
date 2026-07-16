/**
 * CircleCompassSuggestions — "Suggested for your Circle" feed card.
 *
 * Calls GET /api/circle/compass-suggestions (via getCompassSuggestions) and
 * surfaces actionable Circle prompts in the Compass/Pulse "For You" feed.
 * Suppressed entirely when the cards array is empty.
 * Guarded by the find_your_circle_enabled feature flag (via useCircleFlag).
 *
 * Each card row maps to one CompassCircleCard returned by the endpoint.
 * Tapping "Invite" navigates to the /circle-presence screen for that context.
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Image,
} from 'react-native';
import { router } from 'expo-router';
import { Users, Radio, MapPin } from 'lucide-react-native';
import { getCompassSuggestions, type CompassCircleCard } from '../services/circle.ts';
import { useSession } from '../context/SessionContext.tsx';
import { color, space, radius, type as t } from '../theme/tokens.ts';

const MAX_CARDS = 3;

function AvatarIcon({ cardType }: { cardType: CompassCircleCard['cardType'] }) {
  const bg =
    cardType === 'circle_active' ? color.signal + '18'
    : cardType === 'turn_on_circle' ? '#8B5CF618'
    : '#F59E0B18';

  return (
    <View style={[styles.avatarWrap, { backgroundColor: bg }]}>
      {cardType === 'circle_active' && <Radio size={18} color={color.signal} />}
      {cardType === 'turn_on_circle' && <Users size={18} color="#8B5CF6" />}
      {cardType === 'set_meeting_point' && <MapPin size={18} color="#F59E0B" />}
    </View>
  );
}

function subLabel(card: CompassCircleCard): string {
  switch (card.cardType) {
    case 'circle_active': {
      const n = card.metadata.activeCount ?? 0;
      return n === 1 ? '1 member sharing now' : `${n} members sharing now`;
    }
    case 'turn_on_circle': {
      const n = card.metadata.othersActiveCount ?? 0;
      return n > 0
        ? `${n} member${n > 1 ? 's' : ''} already active`
        : 'Enable location sharing with your group';
    }
    case 'set_meeting_point':
      return 'No meeting point set yet';
    default:
      return '';
  }
}

interface CardRowProps {
  card: CompassCircleCard;
}

function CardRow({ card }: CardRowProps) {
  function handleInvite() {
    router.push({
      pathname: '/circle-presence',
      params: {
        contextType: card.contextType,
        contextId: card.contextId,
      },
    } as any);
  }

  return (
    <Pressable style={styles.row} onPress={handleInvite}>
      <AvatarIcon cardType={card.cardType} />
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={1}>{card.contextTitle}</Text>
        <Text style={styles.rowSub} numberOfLines={1}>{subLabel(card)}</Text>
      </View>
      <Pressable
        style={styles.inviteBtn}
        onPress={handleInvite}
        hitSlop={8}
      >
        <Text style={styles.inviteBtnText}>Invite</Text>
      </Pressable>
    </Pressable>
  );
}

export function CircleCompassSuggestions() {
  const { isAuthed } = useSession();
  const [cards, setCards] = useState<CompassCircleCard[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!isAuthed) { setLoading(false); return; }
    setLoading(true);
    const res = await getCompassSuggestions();
    if (res.ok) {
      setCards((res.data.cards ?? []).slice(0, MAX_CARDS));
    }
    setLoading(false);
  }, [isAuthed]);

  useEffect(() => { load(); }, [load]);

  if (!isAuthed) return null;
  if (loading) return null;
  if (cards.length === 0) return null;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Users size={16} color={color.ink} />
        <Text style={styles.title}>Suggested for your Circle</Text>
        <Pressable onPress={() => router.push('/circle' as any)} hitSlop={8}>
          <Text style={styles.seeAll}>Manage →</Text>
        </Pressable>
      </View>
      <View style={styles.card}>
        {cards.map((c, i) => (
          <View key={`${c.contextType}-${c.contextId}-${c.cardType}`}>
            {i > 0 && <View style={styles.divider} />}
            <CardRow card={c} />
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: space.xl,
    marginHorizontal: space.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginBottom: space.md,
  },
  title: {
    ...t.title,
    color: color.ink,
    fontSize: 17,
    flex: 1,
  },
  seeAll: {
    ...t.small,
    color: color.signal,
    fontWeight: '700',
  },
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingVertical: 12,
    gap: space.md,
  },
  avatarWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 14,
  },
  rowSub: {
    ...t.small,
    color: color.mute,
    fontSize: 11,
  },
  inviteBtn: {
    backgroundColor: color.signal,
    borderRadius: radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 7,
    flexShrink: 0,
  },
  inviteBtnText: {
    ...t.bodyStrong,
    color: '#fff',
    fontSize: 13,
  },
  divider: {
    height: 1,
    backgroundColor: color.haze,
    marginHorizontal: space.md,
  },
});
