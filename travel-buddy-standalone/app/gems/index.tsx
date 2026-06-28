/**
 * Gems — Hidden Gems discovery screen
 * Route: /gems
 *
 * Tab bar: Discover · Saved · Layover
 */
import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  TextInput, ActivityIndicator, RefreshControl, ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useGemList, useSavedGems, useLayoverGems } from '../../src/hooks/useHiddenGems';
import { verificationBadge, sensitivityLabel, type HiddenGem, type GemCategory } from '../../src/services/hiddenGems';
import { SafeAreaView } from 'react-native-safe-area-context';

// ── Category filter chips ─────────────────────────────────────────────────────

const CATEGORIES: Array<{ key: GemCategory | 'all'; label: string; icon: string }> = [
  { key: 'all',          label: 'All',       icon: 'apps-outline' },
  { key: 'food',         label: 'Food',      icon: 'restaurant-outline' },
  { key: 'drink',        label: 'Drink',     icon: 'wine-outline' },
  { key: 'nature',       label: 'Nature',    icon: 'leaf-outline' },
  { key: 'culture',      label: 'Culture',   icon: 'library-outline' },
  { key: 'adventure',    label: 'Adventure', icon: 'compass-outline' },
  { key: 'viewpoint',    label: 'Views',     icon: 'eye-outline' },
  { key: 'local_secret', label: 'Local',     icon: 'key-outline' },
  { key: 'market',       label: 'Market',    icon: 'storefront-outline' },
  { key: 'wellness',     label: 'Wellness',  icon: 'heart-outline' },
];

// ── Gem card ──────────────────────────────────────────────────────────────────

function GemCard({ gem, onPress }: { gem: HiddenGem; onPress: () => void }) {
  const isProtected   = gem.sensitivityLevel === 'protected';
  const isApproximate = gem.coordsPrecision === 'approximate';

  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.8}>
      <View style={styles.cardHeader}>
        <View style={[styles.categoryBadge, { backgroundColor: categoryColor(gem.category) }]}>
          <Text style={styles.categoryText}>{gem.category}</Text>
        </View>
        {isProtected && (
          <View style={styles.protectedBadge}>
            <Ionicons name="lock-closed" size={11} color="#fff" />
            <Text style={styles.protectedText}>Protected</Text>
          </View>
        )}
      </View>

      <Text style={styles.gemName} numberOfLines={2}>{gem.name}</Text>

      <View style={styles.locationRow}>
        <Ionicons
          name={isApproximate ? 'navigate-circle-outline' : isProtected ? 'eye-off-outline' : 'location-outline'}
          size={14}
          color="#8A9BB5"
        />
        <Text style={styles.locationText}>
          {gem.neighborhood ? `${gem.neighborhood}, ` : ''}{gem.city}
          {isApproximate ? '  (approx)' : ''}
        </Text>
      </View>

      {gem.description ? (
        <Text style={styles.description} numberOfLines={2}>{gem.description}</Text>
      ) : null}

      <View style={styles.cardFooter}>
        <View style={styles.verBadge}>
          <Ionicons name="checkmark-circle-outline" size={12} color="#4CAF7D" />
          <Text style={styles.verText}>{verificationBadge(gem.verificationLevel)}</Text>
        </View>
        <View style={styles.statsRow}>
          {gem.priceRange ? <Text style={styles.price}>{gem.priceRange}</Text> : null}
          <Ionicons name="bookmark-outline" size={13} color="#8A9BB5" />
          <Text style={styles.statNum}>{gem.saveCount}</Text>
        </View>
      </View>

      {gem.vibeTags.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tagScroll}>
          {gem.vibeTags.slice(0, 5).map((t) => (
            <View key={t} style={styles.tag}>
              <Text style={styles.tagText}>#{t}</Text>
            </View>
          ))}
        </ScrollView>
      )}
    </TouchableOpacity>
  );
}

// ── Discover tab ──────────────────────────────────────────────────────────────

function DiscoverTab({ viewMode = 'list' }: { viewMode?: 'list' | 'map' }) {
  const router = useRouter();
  const [city, setCity]           = useState('');
  const [category, setCategory]   = useState<GemCategory | 'all'>('all');
  const [appliedCity, setApplied] = useState('');
  const [nearMe, setNearMe]       = useState(false);

  const { gems, loading, error, refresh } = useGemList({
    city:     appliedCity || undefined,
    category: category === 'all' ? undefined : category,
  });

  const applySearch = useCallback(() => { setApplied(city.trim()); }, [city]);

  return (
    <View style={{ flex: 1 }}>
      {/* Search bar */}
      <View style={styles.searchRow}>
        <View style={styles.searchBox}>
          <Ionicons name="search" size={16} color="#8A9BB5" />
          <TextInput
            style={styles.searchInput}
            value={city}
            onChangeText={setCity}
            placeholder="Filter by city…"
            placeholderTextColor="#8A9BB5"
            returnKeyType="search"
            onSubmitEditing={applySearch}
          />
          {city.length > 0 && (
            <TouchableOpacity onPress={() => { setCity(''); setApplied(''); }}>
              <Ionicons name="close-circle" size={16} color="#8A9BB5" />
            </TouchableOpacity>
          )}
        </View>
        <TouchableOpacity style={styles.searchBtn} onPress={applySearch}>
          <Text style={styles.searchBtnText}>Go</Text>
        </TouchableOpacity>
      </View>

      {/* Category chips + Near Me */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll}>
        {/* Near Me chip */}
        <TouchableOpacity
          style={[styles.chip, nearMe && styles.chipActive]}
          onPress={() => setNearMe((v) => !v)}
        >
          <Ionicons name="navigate-outline" size={14} color={nearMe ? '#fff' : '#8A9BB5'} />
          <Text style={[styles.chipText, nearMe && styles.chipTextActive]}>Near Me</Text>
        </TouchableOpacity>
        {CATEGORIES.map((c) => (
          <TouchableOpacity
            key={c.key}
            style={[styles.chip, category === c.key && styles.chipActive]}
            onPress={() => setCategory(c.key)}
          >
            <Ionicons
              name={c.icon as any}
              size={14}
              color={category === c.key ? '#fff' : '#8A9BB5'}
            />
            <Text style={[styles.chipText, category === c.key && styles.chipTextActive]}>
              {c.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Map placeholder — shown when map toggle is active */}
      {viewMode === 'map' && (
        <View style={styles.mapPlaceholder}>
          <Ionicons name="map-outline" size={48} color="#4C8BF5" />
          <Text style={styles.mapPlaceholderText}>Map view</Text>
          <Text style={styles.mapPlaceholderSub}>
            {gems.length > 0 ? `${gems.length} gems in this area` : 'No gems to display'}
          </Text>
        </View>
      )}

      {/* Gem list — only shown in list mode */}
      {viewMode === 'list' && (
        loading && gems.length === 0 ? (
          <View style={styles.center}><ActivityIndicator color="#4C8BF5" /></View>
        ) : error ? (
          <View style={styles.center}>
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity onPress={refresh} style={styles.retryBtn}>
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : gems.length === 0 ? (
          <View style={styles.center}>
            <Ionicons name="diamond-outline" size={48} color="#8A9BB5" />
            <Text style={styles.emptyTitle}>No hidden gems found</Text>
            <Text style={styles.emptySubtitle}>Try a different city or category</Text>
          </View>
        ) : (
          <FlatList
            data={gems}
            keyExtractor={(g) => g.id}
            renderItem={({ item }) => (
              <GemCard gem={item} onPress={() => router.push(`/gems/${item.id}`)} />
            )}
            contentContainerStyle={styles.list}
            refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} />}
            ItemSeparatorComponent={() => <View style={styles.sep} />}
          />
        )
      )}
    </View>
  );
}

// ── Saved tab ─────────────────────────────────────────────────────────────────

function SavedTab() {
  const router = useRouter();
  const { gems, loading, error, refresh } = useSavedGems();

  if (loading && gems.length === 0) {
    return <View style={styles.center}><ActivityIndicator color="#4C8BF5" /></View>;
  }
  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }
  if (gems.length === 0) {
    return (
      <View style={styles.center}>
        <Ionicons name="bookmark-outline" size={48} color="#8A9BB5" />
        <Text style={styles.emptyTitle}>No saved gems yet</Text>
        <Text style={styles.emptySubtitle}>Save gems you want to revisit</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={gems}
      keyExtractor={(g) => g.id}
      renderItem={({ item }) => (
        <GemCard gem={item} onPress={() => router.push(`/gems/${item.id}`)} />
      )}
      contentContainerStyle={styles.list}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} />}
      ItemSeparatorComponent={() => <View style={styles.sep} />}
    />
  );
}

// ── Layover tab ───────────────────────────────────────────────────────────────

const LAYOVER_OPTIONS = [
  { label: '1 h',   minutes: 60 },
  { label: '2 h',   minutes: 120 },
  { label: '3 h',   minutes: 180 },
  { label: '5 h',   minutes: 300 },
  { label: '8 h',   minutes: 480 },
];

function LayoverTab() {
  const router = useRouter();
  const [selected, setSelected] = useState(120);
  const { gems, loading } = useLayoverGems(selected);

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.layoverHeader}>
        <Text style={styles.layoverTitle}>How long is your layover?</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll}>
          {LAYOVER_OPTIONS.map((o) => (
            <TouchableOpacity
              key={o.minutes}
              style={[styles.chip, selected === o.minutes && styles.chipActive]}
              onPress={() => setSelected(o.minutes)}
            >
              <Text style={[styles.chipText, selected === o.minutes && styles.chipTextActive]}>
                {o.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color="#4C8BF5" /></View>
      ) : gems.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="airplane-outline" size={48} color="#8A9BB5" />
          <Text style={styles.emptyTitle}>No quick gems nearby</Text>
          <Text style={styles.emptySubtitle}>Try a longer window</Text>
        </View>
      ) : (
        <FlatList
          data={gems}
          keyExtractor={(g) => g.id}
          renderItem={({ item }) => (
            <GemCard gem={item} onPress={() => router.push(`/gems/${item.id}`)} />
          )}
          contentContainerStyle={styles.list}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
        />
      )}
    </View>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

const TABS = ['Discover', 'Saved', 'Layover'] as const;
type Tab = typeof TABS[number];

type ViewMode = 'list' | 'map';

export default function GemsScreen() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<Tab>('Discover');
  const [viewMode, setViewMode]   = useState<ViewMode>('list');

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Hidden Gems</Text>
        <View style={styles.headerActions}>
          {/* Map / List toggle — only shown on Discover tab */}
          {activeTab === 'Discover' && (
            <TouchableOpacity
              style={styles.viewToggle}
              onPress={() => setViewMode((m) => m === 'list' ? 'map' : 'list')}
            >
              <Ionicons
                name={viewMode === 'list' ? 'map-outline' : 'list-outline'}
                size={20}
                color="#4C8BF5"
              />
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.submitBtn}
            onPress={() => router.push('/gems/submit')}
          >
            <Ionicons name="add" size={20} color="#fff" />
            <Text style={styles.submitBtnText}>Submit</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Tabs */}
      <View style={styles.tabBar}>
        {TABS.map((t) => (
          <TouchableOpacity
            key={t}
            style={[styles.tab, activeTab === t && styles.tabActive]}
            onPress={() => setActiveTab(t)}
          >
            <Text style={[styles.tabText, activeTab === t && styles.tabTextActive]}>{t}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Content */}
      <View style={{ flex: 1 }}>
        {activeTab === 'Discover' && <DiscoverTab viewMode={viewMode} />}
        {activeTab === 'Saved'    && <SavedTab />}
        {activeTab === 'Layover'  && <LayoverTab />}
      </View>
    </SafeAreaView>
  );
}

// ── Utils ─────────────────────────────────────────────────────────────────────

function categoryColor(cat: GemCategory): string {
  const MAP: Record<GemCategory, string> = {
    food:         '#FF6B35',
    drink:        '#B388FF',
    nature:       '#4CAF7D',
    culture:      '#FF8F00',
    adventure:    '#1976D2',
    nightlife:    '#7B1FA2',
    wellness:     '#00838F',
    local_secret: '#C0392B',
    market:       '#E65100',
    viewpoint:    '#0097A7',
    transport:    '#546E7A',
    other:        '#78909C',
  };
  return MAP[cat] ?? '#78909C';
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0A1628' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  headerTitle: { fontSize: 24, fontWeight: '700', color: '#E8F0FE' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  viewToggle: { padding: 8, borderRadius: 20, backgroundColor: '#1E2D45' },
  mapPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  mapPlaceholderText: { fontSize: 18, fontWeight: '700', color: '#E8F0FE' },
  mapPlaceholderSub: { fontSize: 14, color: '#8A9BB5' },
  submitBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#4C8BF5',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 4,
  },
  submitBtnText: { color: '#fff', fontWeight: '600', fontSize: 14 },

  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#1E2D45',
    marginHorizontal: 20,
  },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  tabActive: { borderBottomWidth: 2, borderBottomColor: '#4C8BF5' },
  tabText: { color: '#8A9BB5', fontSize: 14, fontWeight: '500' },
  tabTextActive: { color: '#4C8BF5', fontWeight: '700' },

  searchRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 10,
    alignItems: 'center',
  },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1E2D45',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  searchInput: { flex: 1, color: '#E8F0FE', fontSize: 15 },
  searchBtn: {
    backgroundColor: '#4C8BF5',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  searchBtnText: { color: '#fff', fontWeight: '600' },

  chipScroll: { paddingHorizontal: 16, marginBottom: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#2A3D5E',
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 8,
    gap: 5,
  },
  chipActive: { backgroundColor: '#4C8BF5', borderColor: '#4C8BF5' },
  chipText: { color: '#8A9BB5', fontSize: 13, fontWeight: '500' },
  chipTextActive: { color: '#fff', fontWeight: '600' },

  list: { paddingHorizontal: 16, paddingBottom: 24 },
  sep: { height: 12 },

  card: {
    backgroundColor: '#13213A',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1E2D45',
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  categoryBadge: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  categoryText: { color: '#fff', fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  protectedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#7B1FA2',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    gap: 3,
  },
  protectedText: { color: '#fff', fontSize: 11, fontWeight: '700' },

  gemName: { fontSize: 18, fontWeight: '700', color: '#E8F0FE', marginBottom: 6 },
  locationRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 8 },
  locationText: { color: '#8A9BB5', fontSize: 13 },
  description: { color: '#B0C4DE', fontSize: 14, lineHeight: 20, marginBottom: 10 },

  cardFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  verBadge: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  verText: { color: '#4CAF7D', fontSize: 12, fontWeight: '600' },
  statsRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  price: { color: '#8A9BB5', fontSize: 13, marginRight: 4 },
  statNum: { color: '#8A9BB5', fontSize: 12 },

  tagScroll: { marginTop: 10 },
  tag: {
    backgroundColor: '#1E2D45',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginRight: 6,
  },
  tagText: { color: '#8A9BB5', fontSize: 12 },

  layoverHeader: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
  layoverTitle: { color: '#E8F0FE', fontSize: 16, fontWeight: '600', marginBottom: 10 },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  errorText: { color: '#FF6B6B', fontSize: 15, textAlign: 'center', marginBottom: 14 },
  retryBtn: { backgroundColor: '#1E2D45', borderRadius: 10, paddingHorizontal: 20, paddingVertical: 10 },
  retryText: { color: '#4C8BF5', fontWeight: '600' },
  emptyTitle: { color: '#E8F0FE', fontSize: 18, fontWeight: '700', marginTop: 14, textAlign: 'center' },
  emptySubtitle: { color: '#8A9BB5', fontSize: 14, marginTop: 6, textAlign: 'center' },
});
