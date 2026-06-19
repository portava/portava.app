import React from 'react';
import { View, Text, Image, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import Svg, { Path, Defs, Pattern, Rect, Circle, G } from 'react-native-svg';
import { Plane, MapPin, User as UserIcon, ShieldCheck, Pencil, UsersRound } from 'lucide-react-native';
import type { User } from '../types/models';
import { Chip } from './ui';
import { PassportMonogramWatermark, PassportInkStamp, PassportHeroBackdrop } from './PassportMarks';
import { color, space, radius, type as t, shadow } from '../theme/tokens';

const INTEREST_LABEL: Record<string, string> = {
  nightlife: 'Nightlife', food: 'Food', beach: 'Beach', luxury: 'Luxury',
  culture: 'Culture', adventure: 'Adventure', wellness: 'Wellness',
  photography: 'Photography', backpacking: 'Backpacking', shopping: 'Shopping',
  business: 'Business', dating: 'Social', events: 'Events',
};

/** Guilloche + watermark seal behind the profile photo — passport security feel. */
function PhotoBackdrop() {
  return (
    <Svg style={StyleSheet.absoluteFill} viewBox="0 0 160 200" pointerEvents="none">
      <Defs>
        <Pattern id="wave" width="20" height="20" patternUnits="userSpaceOnUse">
          <Path d="M0,10 Q5,2 10,10 T20,10" stroke={color.deep} strokeWidth="0.4" fill="none" opacity="0.18" />
        </Pattern>
      </Defs>
      <Rect x="0" y="0" width="160" height="200" fill="url(#wave)" />
      {/* concentric guilloche rings */}
      {[34, 28, 22, 16].map((r) => (
        <Circle key={r} cx="80" cy="70" r={r} stroke={color.deep} strokeWidth="0.5" fill="none" opacity="0.16" />
      ))}
    </Svg>
  );
}

/** ID-photo crop marks at the four corners of the photo frame. */
function CropMarks() {
  const mark = (style: any) => <View style={[styles.crop, style]} />;
  return (
    <>
      {mark(styles.cropTL)}{mark(styles.cropTR)}
      {mark(styles.cropBL)}{mark(styles.cropBR)}
    </>
  );
}

export function PassportHero({
  user,
  trustScore,
  passId = 'TB-2026-0001',
}: {
  user: User;
  trustScore: number;
  passId?: string;
}) {
  const interests = user.interests ?? [];
  return (
    <View style={styles.card}>
      {/* document texture backdrop — behind everything in the hero */}
      <PassportHeroBackdrop />
      {/* top-right entry ink stamp */}
      <View style={styles.inkStamp}><PassportInkStamp rotate={-8} /></View>
      {/* top passport label row */}
      <View style={styles.topRow}>
        <View style={styles.brandRow}>
          <Plane size={18} color={color.ink} />
          <View>
            <Text style={styles.brand}>TRAVEL BUDDY PASSPORT</Text>
            <Text style={styles.brandSub}>SOCIAL TRAVEL ID</Text>
          </View>
        </View>
        <View style={styles.passIdWrap}>
          <Text style={styles.passId}>PASS ID: {passId}</Text>
        </View>
      </View>
      <View style={styles.topDivider} />

      {/* main identity area */}
      <View style={styles.identityRow}>
        {/* photo with document frame + backdrop + crop marks */}
        <View style={styles.photoBox}>
          {/* large subtle TB monogram behind the photo */}
          <PassportMonogramWatermark size={150} />
          <PhotoBackdrop />
          <View style={styles.photoFrame}>
            <Image source={{ uri: user.avatarUrl }} style={styles.photo} />
            <CropMarks />
          </View>
          {/* ink stamp overlapping lower-left corner of the photo */}
          <View style={styles.overlapStamp} pointerEvents="none">
            <View style={styles.overlapRing}>
              <Text style={styles.overlapText}>VERIFIED</Text>
              <Text style={styles.overlapSub}>TRAVELER</Text>
            </View>
          </View>
        </View>

        {/* details */}
        <View style={styles.details}>
          <View style={styles.nameRow}>
            <Text style={styles.name}>{user.name}</Text>
            <View style={styles.trustChip}>
              <ShieldCheck size={13} color={color.signal} />
              <Text style={styles.trustText}>Trust {trustScore}</Text>
            </View>
          </View>

          <View style={styles.metaRow}>
            <MapPin size={14} color={color.deep} />
            <Text style={styles.location}>{user.homeCity}, {user.homeCountry}</Text>
          </View>

          <View style={styles.metaRow}>
            <UserIcon size={14} color={color.ink} />
            <Text style={styles.status}>
              {user.travelStyle === 'solo' ? 'Solo Traveler' : user.travelStyle}
            </Text>
            {user.openToMeet && (
              <>
                <Text style={styles.dot}>·</Text>
                <View style={styles.liveDot} />
                <Text style={styles.status}>Open to Meet</Text>
              </>
            )}
          </View>

          {/* PRESERVED buttons */}
          <View style={styles.buttons}>
            <Pressable style={styles.primaryBtn} onPress={() => { /* open to meet toggle */ }}>
              <UsersRound size={16} color={color.onInk} />
              <Text style={styles.primaryText}>Open to Meet</Text>
            </Pressable>
            <Pressable style={styles.editBtn} onPress={() => router.push('/(tabs)/discovery')}>
              <Pencil size={15} color={color.ink} />
              <Text style={styles.editText}>Edit</Text>
            </Pressable>
          </View>
        </View>
      </View>

      {/* bio */}
      {user.bio ? (
        <Text style={styles.bio}>“{user.bio}”</Text>
      ) : (
        <Text style={styles.bioEmpty}>Add a short travel bio.</Text>
      )}

      {/* interests */}
      <View style={styles.interestsHead}>
        <Text style={styles.interestsLabel}>INTERESTS</Text>
        <Plane size={11} color={color.signal} />
      </View>
      {interests.length ? (
        <View style={styles.interests}>
          {interests.slice(0, 8).map((i) => <Chip key={i} label={INTEREST_LABEL[i] ?? i} />)}
        </View>
      ) : (
        <Text style={styles.bioEmpty}>Add interests so travelers know your vibe.</Text>
      )}

      {/* MRZ microtext divider */}
      <View style={styles.mrzRow}>
        <Text style={styles.mrzChevron}>‹‹‹‹‹</Text>
        <Text style={styles.mrz}>TRAVEL BUDDY · VERIFIED TRAVEL ID · SOCIAL PASSPORT</Text>
        <Text style={styles.mrzChevron}>›››››</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    margin: space.lg,
    borderRadius: radius.lg,
    backgroundColor: '#FBFAF6', // ivory paper
    borderWidth: 1.5,
    borderColor: color.haze,
    padding: space.lg,
    overflow: 'hidden',
    ...shadow.card,
  },
  inkStamp: { position: 'absolute', top: 56, right: 14, zIndex: 1 },
  overlapStamp: { position: 'absolute', bottom: 2, left: -2, zIndex: 3 },
  overlapRing: {
    width: 52, height: 52, borderRadius: 26, borderWidth: 1.5, borderColor: color.signal,
    alignItems: 'center', justifyContent: 'center', opacity: 0.5,
    transform: [{ rotate: '-12deg' }], backgroundColor: 'rgba(250,249,246,0.4)',
  },
  overlapText: { fontFamily: 'Courier', fontSize: 8, fontWeight: '700', color: color.signal, letterSpacing: 0.5 },
  overlapSub: { fontFamily: 'Courier', fontSize: 6.5, fontWeight: '700', color: color.signal, letterSpacing: 1 },
  topRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  brand: { ...t.bodyStrong, color: color.ink, letterSpacing: 0.5, fontSize: 14 },
  brandSub: { fontFamily: 'Courier', fontSize: 9, color: color.deep, letterSpacing: 1.5, marginTop: 1 },
  passIdWrap: {},
  passId: { fontFamily: 'Courier', fontSize: 10, color: color.deep, fontWeight: '700', letterSpacing: 0.5 },
  topDivider: { height: 1, backgroundColor: color.haze, marginVertical: space.md },

  identityRow: { flexDirection: 'row', gap: space.lg },
  photoBox: { width: 120, height: 150, alignItems: 'center', justifyContent: 'center' },
  photoFrame: {
    width: 104, height: 132, borderRadius: 6, borderWidth: 2, borderColor: color.paper,
    backgroundColor: color.haze, overflow: 'hidden', ...shadow.card,
  },
  photo: { width: '100%', height: '100%' },
  crop: { position: 'absolute', width: 14, height: 14, borderColor: color.deep },
  cropTL: { top: 4, left: 4, borderTopWidth: 2, borderLeftWidth: 2 },
  cropTR: { top: 4, right: 4, borderTopWidth: 2, borderRightWidth: 2 },
  cropBL: { bottom: 4, left: 4, borderBottomWidth: 2, borderLeftWidth: 2 },
  cropBR: { bottom: 4, right: 4, borderBottomWidth: 2, borderRightWidth: 2 },

  details: { flex: 1, gap: space.sm },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  name: { ...t.hero, color: color.ink, fontSize: 30 },
  trustChip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1.5, borderColor: color.signal, borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 3 },
  trustText: { ...t.small, fontWeight: '800', color: color.signal },

  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  location: { ...t.bodyStrong, color: color.ink },
  status: { ...t.body, color: color.ink, fontWeight: '600' },
  dot: { color: color.faint, marginHorizontal: 2 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.success },

  buttons: { flexDirection: 'row', gap: space.sm, marginTop: space.xs },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: color.signal, paddingHorizontal: space.lg, paddingVertical: space.md, borderRadius: radius.md },
  primaryText: { ...t.bodyStrong, color: color.onInk },
  editBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: color.haze, paddingHorizontal: space.lg, paddingVertical: space.md, borderRadius: radius.md, backgroundColor: color.paper },
  editText: { ...t.bodyStrong, color: color.ink },

  bio: { ...t.body, color: color.ink, fontStyle: 'italic', marginTop: space.lg },
  bioEmpty: { ...t.body, color: color.faint, marginTop: space.sm },

  interestsHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: space.lg },
  interestsLabel: { fontFamily: 'Courier', fontSize: 11, color: color.deep, letterSpacing: 2, fontWeight: '700' },
  interests: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md, justifyContent: 'center' },

  mrzRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm, marginTop: space.lg, paddingTop: space.md, borderTopWidth: 1, borderTopColor: color.haze },
  mrz: { fontFamily: 'Courier', fontSize: 9, color: color.deep, letterSpacing: 1, fontWeight: '700' },
  mrzChevron: { fontFamily: 'Courier', fontSize: 9, color: color.faint },
});
