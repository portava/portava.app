import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { MapPin, Calendar, User as UserIcon } from 'lucide-react-native';
import type { OwnProfile, PublicProfile } from '../types/models.ts';
import { color, space, radius, type as t } from '../theme/tokens.ts';

const INTEREST_LABEL: Record<string, string> = {
  nightlife: 'Nightlife', food: 'Food', beach: 'Beach', luxury: 'Luxury',
  culture: 'Culture', adventure: 'Adventure', wellness: 'Wellness',
  photography: 'Photography', backpacking: 'Backpacking', shopping: 'Shopping',
  business: 'Business', dating: 'Social', events: 'Events',
};

const TRAVEL_STYLE_LABEL: Record<string, string> = {
  solo: 'Solo Traveler', couple: 'Couple', group: 'Group Traveler', business: 'Business Traveler',
};

export function AboutTab({
  profile,
  isOwner,
  onOpenSettings,
}: {
  profile: OwnProfile | PublicProfile;
  isOwner: boolean;
  onOpenSettings?: () => void;
}) {
  const interests = profile.interests ?? [];
  const style = profile.travelStyle;
  const joined = profile.createdAt
    ? new Date(profile.createdAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    : null;

  const bio = profile.bio;
  const homeCity = profile.homeCity;
  const homeCountry = profile.homeCountry;

  const hasContent = bio || homeCity || style || interests.length > 0 || joined;

  if (!hasContent) {
    return (
      <View style={ab.empty}>
        <Text style={ab.emptyTitle}>Nothing here yet</Text>
        {isOwner && (
          <Pressable style={ab.editBtn} onPress={onOpenSettings}>
            <Text style={ab.editBtnText}>Add profile details</Text>
          </Pressable>
        )}
      </View>
    );
  }

  return (
    <View style={ab.wrap}>
      {bio ? (
        <View style={ab.section}>
          <Text style={ab.sectionLabel}>BIO</Text>
          <Text style={ab.bio}>{bio}</Text>
        </View>
      ) : null}

      {(homeCity || homeCountry) ? (
        <View style={ab.section}>
          <Text style={ab.sectionLabel}>HOME BASE</Text>
          <View style={ab.row}>
            <MapPin size={14} color={color.deep} />
            <Text style={ab.value}>{[homeCity, homeCountry].filter(Boolean).join(', ')}</Text>
          </View>
        </View>
      ) : null}

      {style ? (
        <View style={ab.section}>
          <Text style={ab.sectionLabel}>TRAVEL STYLE</Text>
          <View style={ab.row}>
            <UserIcon size={14} color={color.ink} />
            <Text style={ab.value}>{TRAVEL_STYLE_LABEL[style] ?? style}</Text>
          </View>
        </View>
      ) : null}

      {interests.length > 0 ? (
        <View style={ab.section}>
          <Text style={ab.sectionLabel}>INTERESTS</Text>
          <View style={ab.chips}>
            {interests.map((i) => (
              <View key={i} style={ab.chip}>
                <Text style={ab.chipText}>{INTEREST_LABEL[i] ?? i}</Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {joined ? (
        <View style={ab.section}>
          <Text style={ab.sectionLabel}>MEMBER SINCE</Text>
          <View style={ab.row}>
            <Calendar size={14} color={color.faint} />
            <Text style={ab.value}>{joined}</Text>
          </View>
        </View>
      ) : null}

      {isOwner && (
        <Pressable style={ab.editBtn} onPress={onOpenSettings}>
          <Text style={ab.editBtnText}>Edit in Passport Settings</Text>
        </Pressable>
      )}
    </View>
  );
}

const ab = StyleSheet.create({
  wrap: { paddingHorizontal: space.lg, paddingTop: space.md, gap: space.lg },
  section: { gap: space.sm },
  sectionLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', letterSpacing: 1.5, color: color.mute },
  bio: { ...t.body, color: color.ink, lineHeight: 22 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  value: { ...t.bodyStrong, color: color.ink },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    backgroundColor: color.paperRaised, borderRadius: radius.pill,
    paddingHorizontal: 12, paddingVertical: 5,
    borderWidth: 1, borderColor: color.haze,
  },
  chipText: { ...t.small, color: color.ink, fontWeight: '600' },
  empty: { paddingTop: space.xxxl, alignItems: 'center', gap: space.md },
  emptyTitle: { ...t.body, color: color.mute },
  editBtn: {
    marginTop: space.md, borderWidth: 1, borderColor: color.haze,
    borderRadius: radius.pill, paddingHorizontal: space.xl, paddingVertical: space.md,
    alignSelf: 'center',
  },
  editBtnText: { ...t.bodyStrong, color: color.ink },
});
