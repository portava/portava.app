/**
 * TravelerPreviewCard — compact overlay card shown when a traveler marker is
 * tapped on the Discovery map.
 *
 * Shows ONLY privacy-allowed fields the server already vetted: avatar, name,
 * handle, verified badge, open-to-meet status, broad location ("In {city}")
 * and coarse freshness. Never coordinates, never distances.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { MapPin, X, ArrowRight, HandMetal } from 'lucide-react-native';
import { color, space, radius, type as t, shadow } from '../../theme/tokens.ts';
import { VerifiedStamp } from '../ui/VerifiedStamp.tsx';
import type { MapTraveler } from '../../services/mapTravelers.ts';
import { travelerInitials } from './TravelerMapLayer.tsx';
import { primaryIdentityText, secondaryIdentityText } from '../../lib/displayIdentity.ts';
import { AvatarImage } from '../ui/DisplayMediaImage.tsx';

export function TravelerPreviewCard({ traveler, onClose }: {
  traveler: MapTraveler;
  onClose: () => void;
}) {
  const nameText = primaryIdentityText({ displayName: traveler.displayName, handle: traveler.handle });
  const handleSubline = secondaryIdentityText({ displayName: traveler.displayName, handle: traveler.handle });
  const locationLabel = [traveler.city, traveler.country].filter(Boolean).join(', ');
  const freshLabel = traveler.freshness === 'live' ? 'Active now' : 'Recently active';
  const freshColor = traveler.freshness === 'live' ? '#22C55E' : '#F59E0B';

  const openPassport = () => {
    onClose();
    router.push(`/passport/${traveler.handle ?? traveler.id}` as any);
  };

  return (
    <View style={s.card}>
      <Pressable style={s.closeBtn} onPress={onClose} hitSlop={8}>
        <X size={16} color={color.mute} />
      </Pressable>

      <View style={s.topRow}>
        <AvatarImage
          uri={traveler.avatarUrl}
          user={{ displayName: traveler.displayName, handle: traveler.handle }}
          size={46}
          style={s.avatar}
        />
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={s.nameRow}>
            <Text style={s.name} numberOfLines={1}>{nameText}</Text>
            {traveler.verified ? <VerifiedStamp size="sm" /> : null}
          </View>
          {handleSubline ? (
            <Text style={s.handle} numberOfLines={1}>{handleSubline}</Text>
          ) : null}
        </View>
      </View>

      <View style={s.chipRow}>
        <View style={s.chip}>
          <View style={[s.freshDot, { backgroundColor: freshColor }]} />
          <Text style={s.chipText}>{freshLabel}</Text>
        </View>
        {locationLabel ? (
          <View style={s.chip}>
            <MapPin size={11} color={color.mute} />
            <Text style={s.chipText} numberOfLines={1}>In {locationLabel}</Text>
          </View>
        ) : null}
        {traveler.openToMeet && (
          <View style={[s.chip, s.meetChip]}>
            <HandMetal size={11} color={color.deep} />
            <Text style={[s.chipText, { color: color.deep }]}>Open to meet</Text>
          </View>
        )}
      </View>

      <Pressable style={s.passportBtn} onPress={openPassport}>
        <Text style={s.passportBtnText}>View Passport</Text>
        <ArrowRight size={15} color="#fff" />
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 58,
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    gap: space.sm,
    ...shadow.card,
    elevation: 8,
  },
  closeBtn: {
    position: 'absolute',
    top: 10,
    right: 10,
    zIndex: 2,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingRight: 30,
  },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: color.haze,
  },
  avatarFallback: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: color.deep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitials: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  name: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 15,
    flexShrink: 1,
  },
  handle: {
    ...t.small,
    color: color.mute,
    fontSize: 12,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: color.paper,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.pill,
    paddingHorizontal: 9,
    paddingVertical: 4,
    maxWidth: 220,
  },
  meetChip: {
    backgroundColor: '#E2EDF0',
    borderColor: '#CBDEE3',
  },
  chipText: {
    fontSize: 11,
    fontWeight: '600',
    color: color.mute,
  },
  freshDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  passportBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: color.signal,
    borderRadius: radius.md,
    paddingVertical: 10,
  },
  passportBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
});
