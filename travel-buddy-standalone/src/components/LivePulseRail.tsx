/**
 * LivePulseRail — horizontally scrollable smart rail for the Pulse screen.
 *
 * Features:
 *  - Collapsible: collapsed row shows count summary; tap to expand.
 *  - Filter chips narrow the already-fetched items array client-side.
 *  - Compact skeleton loader, empty state with CTA, and error/retry.
 *  - Each LivePulseCard can be dismissed (editorial cards only).
 */
import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  ScrollView,
  Pressable,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { router } from 'expo-router';
import { ChevronDown, ChevronUp, RefreshCw } from 'lucide-react-native';
import { color, space, type as t } from '../theme/tokens';
import { LivePulseCard } from './LivePulseCard';
import { buildSummaryText, filterItems, RAIL_FILTERS, type RailFilter } from './LivePulseRail.machine';
import type { UseLivePulseResult } from '../hooks/useLivePulse';
import type { LivePulseItem } from '../services/livePulse';

// Re-export so the test file can import from the component barrel if needed
export { buildSummaryText } from './LivePulseRail.machine';

// ── Empty state actions ────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.emptyTitle}>No live plans right now</Text>
      <Text style={styles.emptySub}>Create an event, start a trip, or explore what's near you.</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.emptyActions}>
        {/* Routes match actual Expo Router file structure */}
        <TouchableOpacity style={styles.emptyBtn} onPress={() => router.push('/events/create' as any)}>
          <Text style={styles.emptyBtnText}>Create Event</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.emptyBtn} onPress={() => router.push('/trip/new' as any)}>
          <Text style={styles.emptyBtnText}>New Trip</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.emptyBtn} onPress={() => router.push('/circle' as any)}>
          <Text style={styles.emptyBtnText}>Find Your Circle</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.emptyBtn} onPress={() => router.push('/discover' as any)}>
          <Text style={styles.emptyBtnText}>Choose City</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

// ── Skeleton loader ────────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <View style={styles.skeletonCard}>
      <View style={styles.skeletonLine} />
      <View style={[styles.skeletonLine, { width: '60%' }]} />
      <View style={[styles.skeletonLine, { width: '80%', marginTop: space.sm }]} />
    </View>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

interface LivePulseRailProps {
  pulse: UseLivePulseResult;
}

export function LivePulseRail({ pulse }: LivePulseRailProps) {
  const [expanded, setExpanded] = useState(true);
  const [activeFilter, setActiveFilter] = useState<RailFilter>('All');

  const { items, loading, error, refresh, dismiss, changeContext: _changeContext } = pulse;

  const filteredItems = useMemo(
    () => filterItems(items, activeFilter),
    [items, activeFilter],
  );

  const summaryText = useMemo(() => buildSummaryText(items), [items]);

  if (!loading && !error && items.length === 0) {
    return (
      <View style={styles.container}>
        <Pressable style={styles.headerRow} onPress={() => setExpanded((e) => !e)}>
          <Text style={styles.headerTitle}>Live Pulse</Text>
          {expanded ? <ChevronUp size={16} color={color.mute} /> : <ChevronDown size={16} color={color.mute} />}
        </Pressable>
        {expanded && <EmptyState />}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Collapsible header */}
      <Pressable style={styles.headerRow} onPress={() => setExpanded((e) => !e)}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerTitle}>Live Pulse</Text>
          {!expanded && items.length > 0 && (
            <Text style={styles.summaryText}>{summaryText}</Text>
          )}
        </View>
        {expanded ? <ChevronUp size={16} color={color.mute} /> : <ChevronDown size={16} color={color.mute} />}
      </Pressable>

      {expanded && (
        <>
          {/* Filter chips */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.filterRow}
          >
            {RAIL_FILTERS.map((chip) => (
              <Pressable
                key={chip}
                style={[styles.chip, activeFilter === chip && styles.chipActive]}
                onPress={() => setActiveFilter(chip)}
              >
                <Text style={[styles.chipText, activeFilter === chip && styles.chipTextActive]}>
                  {chip}
                </Text>
              </Pressable>
            ))}
          </ScrollView>

          {/* Content */}
          {loading ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.skeletonRow}>
              {[0, 1, 2].map((i) => <SkeletonCard key={i} />)}
            </ScrollView>
          ) : error ? (
            <View style={styles.errorState}>
              <Text style={styles.errorText}>Couldn't load live plans.</Text>
              <Pressable style={styles.retryBtn} onPress={refresh}>
                <RefreshCw size={14} color={color.signal} />
                <Text style={styles.retryText}>Retry</Text>
              </Pressable>
            </View>
          ) : filteredItems.length === 0 ? (
            <View style={styles.filterEmpty}>
              <Text style={styles.filterEmptyText}>Nothing matches this filter.</Text>
              <Pressable onPress={() => setActiveFilter('All')}>
                <Text style={styles.filterEmptyClear}>Show all</Text>
              </Pressable>
            </View>
          ) : (
            <FlatList
              data={filteredItems}
              horizontal
              showsHorizontalScrollIndicator={false}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.cardRow}
              ItemSeparatorComponent={() => <View style={{ width: space.md }} />}
              renderItem={({ item }) => (
                <LivePulseCard
                  item={item}
                  onDismiss={dismiss}
                  onActionDone={refresh}
                />
              )}
            />
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: space.lg,
    marginBottom: space.sm,
    gap: space.sm,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
  },
  headerLeft: {
    flex: 1,
    gap: 2,
  },
  headerTitle: {
    ...t.title,
    fontSize: 20,
    color: color.ink,
  },
  summaryText: {
    ...t.small,
    fontSize: 12,
    color: color.mute,
  },
  filterRow: {
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: 2,
  },
  chip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: color.haze,
    paddingHorizontal: space.md,
    paddingVertical: 5,
    backgroundColor: color.paper,
  },
  chipActive: {
    backgroundColor: color.signal,
    borderColor: color.signal,
  },
  chipText: {
    ...t.small,
    fontSize: 12,
    color: color.deep,
    fontWeight: '600',
  },
  chipTextActive: {
    color: '#fff',
  },
  cardRow: {
    paddingHorizontal: space.lg,
    paddingVertical: space.xs,
  },
  skeletonRow: {
    paddingHorizontal: space.lg,
    gap: space.md,
  },
  skeletonCard: {
    width: 200,
    height: 130,
    backgroundColor: color.paperRaised,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    gap: space.sm,
  },
  skeletonLine: {
    height: 12,
    width: '100%',
    backgroundColor: color.haze,
    borderRadius: 6,
  },
  emptyState: {
    marginHorizontal: space.lg,
    padding: space.lg,
    backgroundColor: color.paperRaised,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: color.haze,
    gap: space.sm,
  },
  emptyTitle: {
    ...t.bodyStrong,
    color: color.ink,
  },
  emptySub: {
    ...t.small,
    color: color.mute,
    fontSize: 12,
  },
  emptyActions: {
    gap: space.sm,
    paddingTop: space.xs,
  },
  emptyBtn: {
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: 8,
    paddingHorizontal: space.md,
    paddingVertical: 7,
    backgroundColor: color.paper,
  },
  emptyBtnText: {
    ...t.small,
    fontSize: 12,
    fontWeight: '600',
    color: color.deep,
  },
  errorState: {
    marginHorizontal: space.lg,
    padding: space.lg,
    backgroundColor: '#FFF5F5',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#FFCDD2',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
  },
  errorText: {
    ...t.small,
    color: '#C62828',
    flex: 1,
  },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  retryText: {
    ...t.small,
    fontSize: 13,
    fontWeight: '700',
    color: color.signal,
  },
  filterEmpty: {
    marginHorizontal: space.lg,
    padding: space.md,
    alignItems: 'center',
    gap: space.xs,
  },
  filterEmptyText: {
    ...t.small,
    color: color.mute,
  },
  filterEmptyClear: {
    ...t.small,
    color: color.signal,
    fontWeight: '700',
  },
});
