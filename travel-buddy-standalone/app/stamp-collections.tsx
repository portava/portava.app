/**
 * Stamp collections & catalog — TM-social, PASS-F09.
 *
 * Two views over Stamp System v2:
 *   - Collections: GET /api/stamps/me/collections — each active collection with
 *     how many of its stamps I have earned (unrevoked) out of its total.
 *   - All stamps:  GET /api/stamps/definitions — the active catalog: what can be
 *     earned, grouped by category.
 *
 * States are true ones (DV-83): the stamp router answers 503
 * `feature_not_available` while Stamp System v2 is off, which is shown as
 * "not switched on", not as an outage and not as an empty catalog; a failed
 * read is "couldn't load" with a retry; an empty answer is the empty state.
 * The server fails closed when my earned stamps cannot be read, so a progress
 * bar here is never "0 of N" by accident.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { Layers, Tag } from 'lucide-react-native';
import { AppHeader } from '../src/components/ui/AppHeader';
import { EmptyState } from '../src/components/ui/EmptyState';
import { ErrorState } from '../src/components/ui/ErrorState';
import {
  getMyStampCollections, getStampCatalog,
  type StampCollectionProgress, type StampCatalogEntry, type StampBrowseResult,
} from '../src/services/stamps';
import { color, space, radius, type as t } from '../src/theme/tokens';
import { useNavBarScrollHandler, NavBarFiller } from '../src/hooks/useNavBarCollapse';

type View_ = 'collections' | 'catalog';
type Load<T> = { state: 'loading' } | { state: 'disabled' } | { state: 'error' } | { state: 'ok'; data: T };

function toLoad<T>(r: StampBrowseResult<T>): Load<T> {
  if (r.ok) return { state: 'ok', data: r.data };
  return r.disabled ? { state: 'disabled' } : { state: 'error' };
}

function CollectionCard({ c }: { c: StampCollectionProgress }) {
  const pct = c.total > 0 ? Math.min(1, c.earned / c.total) : 0;
  return (
    <View style={s.card} testID={`stamp-collection-${c.id}`}>
      <View style={s.cardHead}>
        <Text style={s.cardTitle} numberOfLines={1}>{c.name}</Text>
        <Text style={[s.count, c.complete && s.countDone]}>
          {c.complete ? 'Complete' : `${c.earned} of ${c.total}`}
        </Text>
      </View>
      {c.description ? <Text style={s.desc} numberOfLines={2}>{c.description}</Text> : null}
      <View
        style={s.track}
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: c.total, now: c.earned }}
      >
        <View style={[s.fill, { width: `${Math.round(pct * 100)}%` }]} />
      </View>
    </View>
  );
}

function CatalogRow({ d }: { d: StampCatalogEntry }) {
  const where = [d.city, d.country].filter(Boolean).join(', ');
  return (
    <View style={s.row} testID={`stamp-def-${d.id}`}>
      <View style={{ flex: 1 }}>
        <Text style={s.rowTitle} numberOfLines={1}>{d.name}</Text>
        <Text style={s.rowMeta} numberOfLines={1}>
          {[d.stampType.replace(/_/g, ' '), d.rarity, where || null].filter(Boolean).join(' · ')}
        </Text>
        {d.description ? <Text style={s.desc} numberOfLines={2}>{d.description}</Text> : null}
      </View>
    </View>
  );
}

export default function StampCollectionsScreen() {
  const navBarScrollHandler = useNavBarScrollHandler();
  const [view, setView] = useState<View_>('collections');
  const [collections, setCollections] = useState<Load<StampCollectionProgress[]>>({ state: 'loading' });
  const [catalog, setCatalog] = useState<Load<StampCatalogEntry[]>>({ state: 'loading' });

  const loadCollections = useCallback(async () => {
    setCollections({ state: 'loading' });
    setCollections(toLoad(await getMyStampCollections()));
  }, []);
  const loadCatalog = useCallback(async () => {
    setCatalog({ state: 'loading' });
    setCatalog(toLoad(await getStampCatalog()));
  }, []);

  // Load each view once, on first show; after that, retry is explicit.
  const started = useRef<Record<View_, boolean>>({ collections: false, catalog: false });
  useEffect(() => {
    if (started.current[view]) return;
    started.current[view] = true;
    void (view === 'collections' ? loadCollections() : loadCatalog());
  }, [view, loadCollections, loadCatalog]);

  const current = view === 'collections' ? collections : catalog;
  const retry = view === 'collections' ? loadCollections : loadCatalog;

  let body: React.ReactNode;
  if (current.state === 'loading') {
    body = <ActivityIndicator color={color.signal} style={{ marginTop: space.xl }} testID="stamp-collections-loading" />;
  } else if (current.state === 'disabled') {
    body = (
      <EmptyState
        icon={Tag}
        title="Stamp collections aren't switched on yet"
        description="They'll appear here once stamps are enabled for your account."
      />
    );
  } else if (current.state === 'error') {
    body = <ErrorState message={view === 'collections' ? "We couldn't load your collections." : "We couldn't load the stamp catalog."} onRetry={() => { void retry(); }} />;
  } else if (view === 'collections') {
    const list = (current as { state: 'ok'; data: StampCollectionProgress[] }).data;
    body = list.length === 0
      ? <EmptyState icon={Layers} title="No collections yet" description="Stamp collections will appear here when Portava publishes them." />
      : <View style={{ gap: space.sm }}>{list.map((c) => <CollectionCard key={c.id} c={c} />)}</View>;
  } else {
    const list = (current as { state: 'ok'; data: StampCatalogEntry[] }).data;
    if (list.length === 0) {
      body = <EmptyState icon={Tag} title="No stamps in the catalog" description="There are no active stamps to earn right now." />;
    } else {
      const groups = new Map<string, StampCatalogEntry[]>();
      for (const d of list) {
        const k = d.category ?? 'other';
        groups.set(k, [...(groups.get(k) ?? []), d]);
      }
      body = (
        <View style={{ gap: space.lg }}>
          {[...groups.entries()].map(([cat, defs]) => (
            <View key={cat} style={{ gap: space.xs }}>
              <Text style={s.groupLabel}>{cat.replace(/_/g, ' ')}</Text>
              {defs.map((d) => <CatalogRow key={d.id} d={d} />)}
            </View>
          ))}
        </View>
      );
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <AppHeader variant="detail" title="Stamp collections" onBack={router.back} />
      <View style={s.segRow} accessibilityRole="tablist">
        {([['collections', 'Collections'], ['catalog', 'All stamps']] as const).map(([k, label]) => (
          <Pressable
            key={k}
            style={[s.seg, view === k && s.segActive]}
            onPress={() => setView(k)}
            accessibilityRole="tab"
            accessibilityState={{ selected: view === k }}
            testID={`stamp-collections-seg-${k}`}
          >
            <Text style={[s.segText, view === k && s.segTextActive]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      <ScrollView
        contentContainerStyle={{ padding: space.lg, paddingTop: space.sm }}
        onScroll={navBarScrollHandler}
        scrollEventThrottle={16}
      >
        {body}
        <NavBarFiller />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  segRow: { flexDirection: 'row', gap: space.xs, paddingHorizontal: space.lg, paddingTop: space.sm },
  seg: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.pill,
    borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised,
  },
  segActive: { backgroundColor: color.ink, borderColor: color.ink },
  segText: { ...t.small, color: color.mute, fontWeight: '600' },
  segTextActive: { color: color.onInk },
  card: {
    backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze,
    padding: space.md, gap: space.xs,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  cardTitle: { ...t.bodyStrong, color: color.ink, fontSize: 14, flex: 1 },
  count: { ...t.small, color: color.mute, fontWeight: '600' },
  countDone: { color: color.deep },
  desc: { ...t.small, color: color.mute },
  track: { height: 6, borderRadius: 3, backgroundColor: color.haze, overflow: 'hidden', marginTop: 4 },
  fill: { height: 6, borderRadius: 3, backgroundColor: color.signal },
  groupLabel: { ...t.small, color: color.mute, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.md,
    backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze,
  },
  rowTitle: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  rowMeta: { ...t.small, color: color.mute, textTransform: 'capitalize' },
});
