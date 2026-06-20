import React, { useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { Map as MapIcon, ChevronRight } from 'lucide-react-native';
import {
  DiscoveryHeader, CompassPickBlock, CategoryChips, FeaturedCard, SectionHead,
} from '../../src/components/DiscoveryWall';
import {
  HiddenGemsSection, NeighborhoodsSection, TravelerPicksSection, SavedIdeasSection, AskCompassCard,
} from '../../src/components/DiscoveryWall2';
import {
  compassPick, forYouSide, featuredExperiences, DISCOVERY_CATEGORIES,
  hiddenGems, neighborhoods, travelerPicks, savedIdeas,
} from '../../src/data/discovery';
import { usePlanPicker } from '../../src/components/PlanPickerController';
import { color, space, radius, type as t } from '../../src/theme/tokens';

export default function Discovery() {
  const [cat, setCat] = useState('All');
  const planPicker = usePlanPicker();

  // simple filter: 'All' shows everything; otherwise match category label
  const visibleFeatured = cat === 'All'
    ? featuredExperiences
    : featuredExperiences.filter((f) => f.category.toLowerCase() === cat.toLowerCase().replace(' ', '_'));

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <DiscoveryHeader
        city="Cebu"
        filterCount={cat !== 'All' ? 1 : 0}
        onSearch={() => router.push('/(tabs)/ai')}
        onFilter={() => router.push('/(tabs)/ai')}
        onSaved={() => router.push('/saved')}
      />
      <ScrollView contentContainerStyle={{ paddingBottom: space.xxxl }} showsVerticalScrollIndicator={false}>
        {/* Compass Pick / For You */}
        <View style={{ marginTop: space.lg }}>
          <CompassPickBlock pick={compassPick} side={forYouSide} />
        </View>

        {/* Category chips */}
        <CategoryChips active={cat} onPick={setCat} categories={DISCOVERY_CATEGORIES} />

        {/* Map placeholder — links to the Live Map (placeholder this pass) */}
        <Pressable style={styles.mapCard} onPress={() => router.push('/live-map')}>
          <View style={styles.mapIcon}><MapIcon size={20} color={color.deep} /></View>
          <View style={{ flex: 1 }}>
            <Text style={styles.mapTitle}>Explore on the map</Text>
            <Text style={styles.mapSub}>Saved pins & circle locations · private by default</Text>
          </View>
          <ChevronRight size={18} color={color.faint} />
        </Pressable>

        {/* Featured Experiences */}
        <SectionHead title="Featured Experiences" onViewAll={() => router.push('/(tabs)/ai')} />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
          {(visibleFeatured.length ? visibleFeatured : featuredExperiences).map((f) => (
            <FeaturedCard key={f.id} item={f} onAdd={() => planPicker.open({ id: f.id, type: 'experience', title: f.name, city: 'Cebu', category: 'Experience' })} />
          ))}
        </ScrollView>

        {/* ── Pass 2 sections ── */}
        <HiddenGemsSection gems={hiddenGems} />
        <NeighborhoodsSection items={neighborhoods} />
        <TravelerPicksSection picks={travelerPicks} />
        <SavedIdeasSection items={savedIdeas} />
        <AskCompassCard />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { gap: space.md, paddingHorizontal: space.lg, paddingBottom: space.sm },
  mapCard: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginHorizontal: space.lg, marginTop: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md },
  mapIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#E2EDF0', alignItems: 'center', justifyContent: 'center' },
  mapTitle: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  mapSub: { ...t.small, color: color.mute, fontSize: 11 },
});
