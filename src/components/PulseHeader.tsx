import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Activity, Search, SlidersHorizontal, MapPin, Pencil, User as UserIcon, Plus } from 'lucide-react-native';
import { color, space, radius, type as t, shadow } from '../theme/tokens';

/** Pulse Wall header: city title + subtitle, search/filter/create, status row. */
export function PulseHeader({
  city = 'Cebu',
  area = 'Lahug District',
  cityFull = 'Cebu City, Philippines',
  availabilityText = 'Open tonight',
  availabilityTime = '6:00 PM – 1:00 AM',
  travelerType = 'Solo Traveler',
  openToMeet = true,
  filterCount = 0,
  onSearch,
  onFilter,
  onCreate,
}: {
  city?: string;
  area?: string;
  cityFull?: string;
  availabilityText?: string;
  availabilityTime?: string;
  travelerType?: string;
  openToMeet?: boolean;
  filterCount?: number;
  onSearch?: () => void;
  onFilter?: () => void;
  onCreate?: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.wrap, { paddingTop: insets.top + space.sm }]}>
      {/* title row */}
      <View style={styles.titleRow}>
        <Activity size={26} color={color.signal} />
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{city} Pulse</Text>
          <Text style={styles.subtitle}>What travelers are sharing in your city</Text>
        </View>
        <Pressable style={styles.iconBtn} onPress={onSearch} hitSlop={6}>
          <Search size={20} color={color.ink} />
        </Pressable>
        <Pressable style={styles.filterBtn} onPress={onFilter} hitSlop={6}>
          <SlidersHorizontal size={18} color={color.ink} />
          <Text style={styles.filterText}>Filter</Text>
          {filterCount > 0 && <View style={styles.badge}><Text style={styles.badgeText}>{filterCount}</Text></View>}
        </Pressable>
      </View>

      {/* status row */}
      <View style={styles.statusRow}>
        <Pressable style={styles.statusCard} onPress={() => router.push('/(tabs)/discovery')}>
          <MapPin size={16} color={color.deep} />
          <View>
            <Text style={styles.statusMain}>{cityFull}</Text>
            <Text style={styles.statusSub}>{area}</Text>
          </View>
        </Pressable>

        <Pressable style={styles.statusCard} onPress={() => router.push('/availability')}>
          <View style={styles.liveDot} />
          <View>
            <Text style={styles.statusMain}>{availabilityText}</Text>
            <Text style={styles.statusSub}>{availabilityTime}</Text>
          </View>
          <Pencil size={13} color={color.faint} />
        </Pressable>

        <Pressable style={styles.statusCard} onPress={() => router.push('/(tabs)/passport')}>
          <UserIcon size={16} color={color.ink} />
          <View>
            <Text style={styles.statusMain}>{travelerType}</Text>
            <Text style={styles.statusSub}>{openToMeet ? 'Open to Meet' : 'Private'}</Text>
          </View>
        </Pressable>

        <Pressable style={styles.createBtn} onPress={onCreate}>
          <Text style={styles.createText}>Create</Text>
          <Plus size={16} color={color.onInk} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { backgroundColor: color.paper, paddingHorizontal: space.lg, paddingBottom: space.md, borderBottomWidth: 1, borderBottomColor: color.haze },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { ...t.hero, color: color.ink, fontSize: 28 },
  subtitle: { ...t.small, color: color.mute, marginTop: 1 },
  iconBtn: { width: 42, height: 42, borderRadius: 21, borderWidth: 1, borderColor: color.haze, alignItems: 'center', justifyContent: 'center', backgroundColor: color.paperRaised },
  filterBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: space.md, height: 42, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  filterText: { ...t.bodyStrong, color: color.ink },
  badge: { minWidth: 20, height: 20, borderRadius: 10, backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  badgeText: { ...t.stamp, color: color.onInk, fontFamily: 'Courier' },

  statusRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.md, flexWrap: 'wrap' },
  statusCard: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm },
  statusMain: { ...t.small, fontWeight: '700', color: color.ink },
  statusSub: { ...t.small, color: color.mute, fontSize: 11 },
  liveDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: color.success },
  createBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: color.signal, paddingHorizontal: space.lg, paddingVertical: space.md, borderRadius: radius.md, ...shadow.card },
  createText: { ...t.bodyStrong, color: color.onInk },
});
