import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { Map as MapIcon, Lock, Users, MapPin, Ghost } from 'lucide-react-native';
import { ScreenHeader } from '../src/components/ScreenHeader';
import { color, space, radius, type as t, shadow } from '../src/theme/tokens';

/**
 * Live Map — PLACEHOLDER this pass. The map data model + privacy rules exist in the
 * backend (migration 0002), but NO live user locations are rendered yet. Location
 * sharing is OFF/private by default and only ever shown to accepted circle members
 * who opt in — enforced by RLS, not the UI.
 */
export default function LiveMap() {
  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScreenHeader title="Live Map" back />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: space.xxxl }}>
        <View style={s.hero}>
          <View style={s.iconWrap}><MapIcon size={30} color={color.deep} /></View>
          <Text style={s.title}>Map view is coming soon</Text>
          <Text style={s.sub}>Your trip pins and saved places will appear here.</Text>
          <View style={s.privacyPill}>
            <Lock size={12} color={color.mute} />
            <Text style={s.privacyText}>Location sharing is private by default</Text>
          </View>
        </View>

        <Text style={s.sectionLabel}>WHAT THE MAP WILL SHOW</Text>
        <Row icon={<MapPin size={18} color={color.signal} />} title="Your saved pins" sub="Places you save and trip-linked spots." />
        <Row icon={<Users size={18} color={color.deep} />} title="Circle members who opt in" sub="Only accepted circle members who choose to share — never anyone else." />
        <Row icon={<Ghost size={18} color={color.mute} />} title="Ghost Mode" sub="Hide yourself instantly, anytime. On by default." />

        <View style={s.note}>
          <Lock size={14} color={color.deep} />
          <Text style={s.noteText}>
            Your location is never shared unless you turn it on. We never show exact live
            location to anyone outside your accepted circle, and stale pings are hidden.
          </Text>
        </View>

        <View style={s.note}>
          <Lock size={14} color={color.deep} />
          <Text style={s.noteText}>
            You can manage location sharing in your privacy settings any time.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

function Row({ icon, title, sub }: { icon: React.ReactNode; title: string; sub: string }) {
  return (
    <View style={s.row}>
      <View style={s.rowIcon}>{icon}</View>
      <View style={{ flex: 1 }}>
        <Text style={s.rowTitle}>{title}</Text>
        <Text style={s.rowSub}>{sub}</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  hero: { backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, padding: space.xl, alignItems: 'center', gap: 6, ...shadow.card },
  iconWrap: { width: 60, height: 60, borderRadius: 30, backgroundColor: '#E2EDF0', alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  title: { ...t.title, color: color.ink, fontSize: 20 },
  sub: { ...t.small, color: color.mute, textAlign: 'center' },
  privacyPill: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: space.sm, backgroundColor: color.paper, paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.pill },
  privacyText: { ...t.small, color: color.mute, fontSize: 11, fontWeight: '600' },
  sectionLabel: { ...t.stamp, fontFamily: 'Courier', color: color.faint, letterSpacing: 1.5, fontSize: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md },
  rowIcon: { width: 38, height: 38, borderRadius: 19, backgroundColor: color.paper, borderWidth: 1, borderColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  rowSub: { ...t.small, color: color.mute, fontSize: 12 },
  note: { flexDirection: 'row', gap: space.sm, backgroundColor: '#E2EDF0', borderRadius: radius.md, padding: space.md },
  noteText: { ...t.small, color: color.deep, flex: 1, fontSize: 12 },
});
