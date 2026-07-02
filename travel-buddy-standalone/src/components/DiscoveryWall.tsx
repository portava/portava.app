import React, { useState, useEffect } from 'react';
import { View, Text, Image, Pressable, ScrollView, StyleSheet, Alert } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Compass, Search, SlidersHorizontal, Bookmark, MapPin, Plus, Sparkles, Info, ChevronRight,
  Gem, Share2, Route, Flag,
} from 'lucide-react-native';
import type { RouteStopDraft } from './RouteBuilderSheet';
import type { DiscoveryItem } from '../data/discovery';
import type { NeighborhoodVibe, TravelerPick, SavedDiscoveryItem } from '../data/discovery';
import { color, space, radius, type as t, shadow, layout } from '../theme/tokens';
import { usePlanPicker } from './PlanPickerController';
import { TravelSectionHeader, TravelEmptyState } from './primitives';
import { DiscoveryShareSheet } from './DiscoveryShareSheet';
import type { DiscoverySharePayload } from './DiscoveryShareSheet';
import { HighlightRing } from './HighlightRing';
import { HighlightViewer } from './HighlightViewer';
import { useHighlightRingState } from '../hooks/useHighlightRingState';
import { saveCommunityPlace, reportCommunityPlace } from '../services/discovery';
import type { PlaceReportReason } from '../services/discovery';

// Module-level set so saved state survives card unmount/remount during scroll recycling.
// Pre-populated by prefillSavedPlaceIds() on Discovery load so returning users
// see filled bookmarks for places they saved in previous sessions.
const savedPlaceIds = new Set<string>();

// Subscribers are notified after prefillSavedPlaceIds() mutates the set so
// already-mounted cards can re-check their id and re-render if needed.
type SavedListener = () => void;
const savedListeners = new Set<SavedListener>();

function subscribeToSavedIds(fn: SavedListener): () => void {
  savedListeners.add(fn);
  return () => savedListeners.delete(fn);
}

/**
 * Seed the module-level saved set from the API response.
 * Called once on Discovery mount (when the user is signed in).
 * Existing entries are not removed — this is additive only.
 * Notifies all mounted card subscribers so they re-render immediately.
 */
export function prefillSavedPlaceIds(ids: string[]): void {
  let changed = false;
  for (const id of ids) {
    if (!savedPlaceIds.has(id)) { savedPlaceIds.add(id); changed = true; }
  }
  if (changed) { for (const fn of savedListeners) fn(); }
}

const REPORT_REASONS: { label: string; value: PlaceReportReason }[] = [
  { label: 'Spam',        value: 'spam' },
  { label: 'Offensive',   value: 'offensive' },
  { label: 'Inaccurate',  value: 'inaccurate' },
  { label: 'Unsafe',      value: 'unsafe' },
  { label: 'Duplicate',   value: 'duplicate' },
  { label: 'Other',       value: 'other' },
];

function showReportSheet(placeId: string, onDone?: () => void) {
  Alert.alert(
    'Report this place',
    'Why are you reporting this place?',
    [
      ...REPORT_REASONS.map(({ label, value }) => ({
        text: label,
        onPress: async () => {
          const result = await reportCommunityPlace(placeId, value);
          Alert.alert(
            result.ok ? 'Reported' : 'Could not report',
            result.ok
              ? 'Thanks for helping keep Discovery accurate.'
              : 'Please try again later.',
          );
          if (result.ok) onDone?.();
        },
      })),
      { text: 'Cancel', style: 'cancel' as const },
    ],
  );
}

/* ── Header ── */
export function DiscoveryHeader({
  city = 'Cebu', filterCount = 0, onSearch, onFilter, onSaved,
}: {
  city?: string; filterCount?: number;
  onSearch?: () => void; onFilter?: () => void; onSaved?: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[h.wrap, { paddingTop: insets.top + space.sm }]}>
      <View style={h.row}>
        <Compass size={26} color={color.signal} />
        <View style={{ flex: 1 }}>
          <Text style={h.title}>{city} Discovery</Text>
          <Text style={h.sub}>Places, gems, and experiences that match your vibe</Text>
        </View>
      </View>
      <View style={h.controls}>
        <Pressable style={h.iconBtn} onPress={onSearch} hitSlop={6}><Search size={20} color={color.ink} /></Pressable>
        <Pressable style={h.filterBtn} onPress={onFilter} hitSlop={6}>
          <SlidersHorizontal size={18} color={color.ink} />
          <Text style={h.filterText}>Filter</Text>
          {filterCount > 0 && <View style={h.badge}><Text style={h.badgeText}>{filterCount}</Text></View>}
        </Pressable>
        <View style={{ flex: 1 }} />
        <Pressable style={h.savedBtn} onPress={onSaved} hitSlop={6}>
          <Bookmark size={17} color={color.signal} />
          <Text style={h.savedText}>Saved</Text>
        </Pressable>
      </View>
    </View>
  );
}

/* ── Provisional label pill ── */
function ProvNote({ text }: { text: string }) {
  return (
    <View style={prov.row}>
      <Info size={12} color={color.mute} />
      <Text style={prov.text}>{text}</Text>
    </View>
  );
}

/* ── Compass Pick / For You ── */
export function CompassPickBlock({ pick, side }: { pick: DiscoveryItem; side: DiscoveryItem[] }) {
  const planPicker = usePlanPicker();
  return (
    <View style={cp.wrap}>
      <Pressable style={cp.hero} onPress={() => router.push('/(tabs)/ai')}>
        <View style={cp.heroMedia}>
          <View style={cp.labelDark}><Text style={cp.labelDarkText}>COMPASS PICK</Text></View>
        </View>
        <View style={cp.heroBody}>
          <View style={cp.heroTitleRow}>
            <Text style={cp.heroTitle}>{pick.name}</Text>
            <Sparkles size={16} color={color.signal} />
          </View>
          <Text style={cp.heroSub}>Top nightlife spot right now</Text>
          <View style={cp.locRow}><MapPin size={13} color={color.onInk} /><Text style={cp.heroLoc}>{pick.neighborhood}, {pick.city}</Text></View>
          <View style={cp.matchRow}><Info size={13} color={color.onInk} /><Text style={cp.matchText}>Matches your nightlife interest</Text></View>
          <View style={cp.heroBtns}>
            <Pressable style={cp.ghostBtn}><Text style={cp.ghostText}>View Details</Text></Pressable>
            <Pressable style={cp.addBtn} onPress={() => planPicker.open({ id: pick.id, type: 'experience', title: pick.name, city: pick.city, category: 'Compass Pick' })}>
              <Plus size={15} color={color.onInk} /><Text style={cp.addText}>Add to Plan</Text>
            </Pressable>
          </View>
        </View>
      </Pressable>

      <View style={cp.sideCol}>
        {side.map((s) => (
          <Pressable key={s.id} style={cp.sideCard} onPress={() => router.push('/(tabs)/ai')}>
            <View style={cp.sideBody}>
              <View style={[cp.sideTag, s.source === 'traveler' ? cp.tagGreen : cp.tagGray]}>
                <Text style={[cp.sideTagText, s.source === 'traveler' ? cp.tagGreenText : cp.tagGrayText]}>
                  {s.source === 'traveler' ? 'POPULAR WITH TRAVELERS' : 'STARTER CITY NOTE'}
                </Text>
              </View>
              <Text style={cp.sideTitle}>{s.name}</Text>
              <Text style={cp.sideBlurb} numberOfLines={2}>{s.blurb}</Text>
              {s.source === 'traveler' && s.savedCount
                ? <View style={cp.savedRow}><Bookmark size={11} color={color.mute} /><Text style={cp.savedNote}>Saved by {s.savedCount} travelers</Text></View>
                : <ProvNote text="Starter city note — provisional" />}
            </View>
            <View style={cp.sideThumb} />
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/* ── Category chips with icons ── */
export function CategoryChips({ active, onPick, categories }: { active: string; onPick: (c: string) => void; categories: readonly string[] }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={cc.row}>
      {categories.map((c) => {
        const on = c === active;
        return (
          <Pressable key={c} style={[cc.chip, on && cc.chipOn]} onPress={() => onPick(c)}>
            <Text style={[cc.chipText, on && cc.chipTextOn]}>{c}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/* ── Featured experience card (horizontal) ── */
export function FeaturedCard({ item, onAdd }: { item: DiscoveryItem; onAdd?: () => void }) {
  return (
    <Pressable style={fc.card} onPress={() => router.push('/(tabs)/ai')}>
      <View style={fc.media}>
        <View style={fc.sparkle}><Sparkles size={14} color={color.onInk} /></View>
      </View>
      <View style={fc.body}>
        <Text style={fc.title} numberOfLines={1}>{item.name}</Text>
        <Text style={fc.sub} numberOfLines={1}>{item.blurb}</Text>
        <View style={fc.locRow}><MapPin size={11} color={color.mute} /><Text style={fc.loc} numberOfLines={1}>{item.neighborhood}</Text></View>
        <View style={fc.btnRow}>
          <Pressable style={fc.addBtn} onPress={onAdd}><Text style={fc.addText}>Add to Plan</Text></Pressable>
          <Pressable style={fc.saveBtn} hitSlop={6}><Bookmark size={16} color={color.mute} /></Pressable>
        </View>
      </View>
    </Pressable>
  );
}

export function SectionHead({ title, onViewAll }: { title: string; onViewAll?: () => void }) {
  return (
    <View style={sh.row}>
      <Text style={sh.title}>{title}</Text>
      <View style={{ flex: 1 }} />
      {onViewAll && (
        <Pressable style={sh.viewAll} onPress={onViewAll} hitSlop={6}>
          <Text style={sh.viewAllText}>View all</Text>
          <ChevronRight size={15} color={color.signal} />
        </Pressable>
      )}
    </View>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   DiscoveryWall2 exports — merged here so DiscoveryWall is the single canonical file.
   ───────────────────────────────────────────────────────────────────────────── */

/** Shared avatar with optional HighlightRing for Discovery user avatars. */
function DiscoveryUserAvatar({ userId, avatarUrl, size, handle }: { userId?: string; avatarUrl: string; size: number; handle?: string | null }) {
  const ringState = useHighlightRingState(userId ?? null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const onPress = ringState?.hasActive
    ? () => setViewerOpen(true)
    : handle
    ? () => router.push(`/u/${encodeURIComponent(handle)}` as any)
    : undefined;
  return (
    <>
      <HighlightRing
        hasActive={ringState?.hasActive ?? false}
        allViewed={ringState?.allViewed ?? false}
        size={size}
        ringWidth={1.5}
        gap={1.5}
        onPress={onPress}
      >
        <Image
          source={{ uri: avatarUrl }}
          style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color.haze }}
        />
      </HighlightRing>
      {ringState?.highlights && (
        <HighlightViewer
          visible={viewerOpen}
          highlights={ringState.highlights}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </>
  );
}

/* ── Hidden Gems ── */
export function HiddenGemCard({ gem, onAddToRoute }: { gem: DiscoveryItem; onAddToRoute?: (draft: RouteStopDraft) => void }) {
  const planPicker = usePlanPicker();
  const [shareVisible, setShareVisible] = useState(false);
  const [saved, setSaved] = useState(() => savedPlaceIds.has(gem.id));
  const [saving, setSaving] = useState(false);
  const [reported, setReported] = useState(false);
  const [displayCount, setDisplayCount] = useState(gem.savedCount ?? 0);
  // Re-sync when prefillSavedPlaceIds() fires after this card has already mounted.
  useEffect(() => subscribeToSavedIds(() => {
    if (!saved) setSaved(savedPlaceIds.has(gem.id));
  }), [gem.id, saved]);
  const sharePayload: DiscoverySharePayload = {
    sourceId: gem.id,
    sourceType: 'hidden_gem',
    title: gem.name,
    category: gem.category ?? 'Hidden Gem',
    city: gem.city ?? gem.neighborhood ?? '',
    blurb: gem.blurb,
  };
  return (
    <>
      <View style={g.card}>
        <View style={g.media}>
          <View style={g.gemBadge}><Gem size={14} color={color.onInk} /></View>
          <Pressable
            style={g.saveIcon}
            hitSlop={layout.hitSlop}
            disabled={saving}
            onPress={async () => {
              if (saved || saving) return;
              setSaving(true);
              const result = await saveCommunityPlace(gem.id);
              if (result.ok) { savedPlaceIds.add(gem.id); setSaved(true); setDisplayCount(c => c + 1); }
              setSaving(false);
            }}
          >
            <Bookmark size={15} color={color.onInk} fill={saved ? color.onInk : 'none'} />
          </Pressable>
        </View>
        <View style={g.body}>
          <Text style={g.name} numberOfLines={1}>{gem.name}</Text>
          <View style={g.locRow}><MapPin size={11} color={color.mute} /><Text style={g.loc} numberOfLines={1}>{gem.neighborhood}</Text></View>
          {gem.rating != null && (
            <View style={g.ratingRow}>
              <Text style={g.ratingStar}>★</Text>
              <Text style={g.ratingValue}>{gem.rating.toFixed(1)}</Text>
            </View>
          )}
          <Text style={g.blurb} numberOfLines={2}>{gem.blurb}</Text>
          {displayCount > 0 && (
            <View style={g.savedRow}>
              <Bookmark size={11} color={color.mute} />
              <Text style={g.savedNote}>Saved by {displayCount} travelers</Text>
            </View>
          )}
          {gem.submittedBy ? (
            <View style={g.byRow}>
              <DiscoveryUserAvatar userId={gem.submittedBy.id} avatarUrl={gem.submittedBy.avatarUrl} size={18} handle={gem.submittedBy.handle} />
              <Pressable
                hitSlop={layout.hitSlop}
                onPress={gem.submittedBy.handle ? () => router.push(`/u/${encodeURIComponent(gem.submittedBy!.handle!)}` as any) : undefined}
              >
                <Text style={g.by}>By {gem.submittedBy.name}</Text>
              </Pressable>
            </View>
          ) : null}
          <View style={g.btnRow}>
            <Pressable style={({ pressed }) => [g.addBtn, pressed && { opacity: layout.pressedOpacity }]}
              onPress={() => planPicker.open({ id: gem.id, type: 'hidden_gem', title: gem.name, city: gem.city, category: 'Hidden Gem' })}>
              <Text style={g.addText}>Add to Plan</Text>
            </Pressable>
            {onAddToRoute ? (
              <Pressable
                style={({ pressed }) => [g.routeBtn, pressed && { opacity: layout.pressedOpacity }]}
                onPress={() => onAddToRoute({ id: gem.id, title: gem.name, lat: null, lng: null, sourceType: 'hidden_gem', sourceId: gem.id, category: gem.category as string })}
                hitSlop={layout.hitSlop}
              >
                <Route size={12} color={color.deep} />
                <Text style={g.routeText}>Route</Text>
              </Pressable>
            ) : null}
            <Pressable
              style={({ pressed }) => [g.shareBtn, pressed && { opacity: layout.pressedOpacity }]}
              hitSlop={layout.hitSlop}
              onPress={() => setShareVisible(true)}
            >
              <Share2 size={13} color={color.mute} />
            </Pressable>
            <Pressable
              style={({ pressed }) => [g.reportBtn, pressed && { opacity: layout.pressedOpacity }]}
              hitSlop={layout.hitSlop}
              disabled={reported}
              onPress={() => showReportSheet(gem.id, () => setReported(true))}
            >
              <Flag size={13} color={reported ? color.mute : color.mute} />
            </Pressable>
          </View>
        </View>
      </View>
      <DiscoveryShareSheet
        visible={shareVisible}
        item={sharePayload}
        onClose={() => setShareVisible(false)}
      />
    </>
  );
}

export function HiddenGemsSection({ gems, onAddToRoute }: { gems: DiscoveryItem[]; onAddToRoute?: (draft: RouteStopDraft) => void }) {
  return (
    <View>
      <TravelSectionHeader title="Hidden Gems (By Travelers)" onAction={() => router.push('/saved')} />
      {gems.length === 0 ? (
        <TravelEmptyState title="No hidden gems yet" sub="Be the first to share a spot travelers should know about." />
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={g.strip}>
          {gems.slice(0, 5).map((gem) => <HiddenGemCard key={gem.id} gem={gem} onAddToRoute={onAddToRoute} />)}
        </ScrollView>
      )}
    </View>
  );
}

/* ── Neighborhoods / Areas by Vibe ── */
export function NeighborhoodCard({ n }: { n: NeighborhoodVibe }) {
  return (
    <Pressable style={nb.card} onPress={() => router.push('/(tabs)/ai')}>
      <View style={nb.media} />
      <View style={nb.overlay}>
        <Text style={nb.vibe} numberOfLines={1}>{n.vibe}</Text>
        <Text style={nb.area} numberOfLines={1}>{n.area}</Text>
      </View>
    </Pressable>
  );
}

export function NeighborhoodsSection({ items }: { items: NeighborhoodVibe[] }) {
  return (
    <View>
      <TravelSectionHeader title="Neighborhoods / Areas by Vibe" onAction={() => router.push('/saved')} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={nb.strip}>
        {items.slice(0, 5).map((n) => <NeighborhoodCard key={n.id} n={n} />)}
      </ScrollView>
      <View style={{ paddingHorizontal: space.lg }}><ProvNote text="Often associated with — starter city notes, provisional" /></View>
    </View>
  );
}

/* ── Traveler Picks ── */
export function TravelerPickCard({ pick, onAddToRoute }: { pick: TravelerPick; onAddToRoute?: (draft: RouteStopDraft) => void }) {
  const planPicker = usePlanPicker();
  const [saved, setSaved] = useState(() => savedPlaceIds.has(pick.id));
  const [saving, setSaving] = useState(false);
  const [reported, setReported] = useState(false);
  const [displayCount, setDisplayCount] = useState(pick.savedCount ?? 0);
  // Re-sync when prefillSavedPlaceIds() fires after this card has already mounted.
  useEffect(() => subscribeToSavedIds(() => {
    if (!saved) setSaved(savedPlaceIds.has(pick.id));
  }), [pick.id, saved]);
  return (
    <View style={tpk.card}>
      <View style={tpk.head}>
        <DiscoveryUserAvatar userId={pick.user.id} avatarUrl={pick.user.avatarUrl} size={32} handle={pick.user.handle} />
        <View style={{ flex: 1 }}>
          <Pressable
            hitSlop={layout.hitSlop}
            onPress={pick.user.handle ? () => router.push(`/u/${encodeURIComponent(pick.user.handle!)}` as any) : undefined}
          >
            <Text style={tpk.user}>{pick.user.name}</Text>
          </Pressable>
          <Text style={tpk.time}>{pick.timeAgo}</Text>
        </View>
        <View style={tpk.tag}><Text style={tpk.tagText}>{pick.tag}</Text></View>
      </View>
      <View style={tpk.placeRow}>
        <Text style={tpk.place} numberOfLines={1}>{pick.place}</Text>
        {pick.rating != null && (
          <View style={tpk.rating}><Text style={tpk.ratingStar}>★</Text><Text style={tpk.ratingText}>{pick.rating.toFixed(1)}</Text></View>
        )}
      </View>
      <Text style={tpk.note} numberOfLines={1}>{pick.note}</Text>
      {displayCount > 0 && (
        <View style={tpk.savedRow}>
          <Bookmark size={11} color={color.mute} />
          <Text style={tpk.savedNote}>Saved by {displayCount} travelers</Text>
        </View>
      )}
      <View style={tpk.btnRow}>
        <Pressable
          style={({ pressed }) => [tpk.saveBtn, pressed && { opacity: layout.pressedOpacity }]}
          hitSlop={layout.hitSlop}
          disabled={saving}
          onPress={async () => {
            if (saved || saving) return;
            setSaving(true);
            const result = await saveCommunityPlace(pick.id);
            if (result.ok) { savedPlaceIds.add(pick.id); setSaved(true); setDisplayCount(c => c + 1); }
            setSaving(false);
          }}
        >
          <Bookmark size={14} color={saved ? color.signal : color.mute} fill={saved ? color.signal : 'none'} />
          <Text style={[tpk.saveText, saved && { color: color.signal }]}>{saved ? 'Saved' : 'Save'}</Text>
        </Pressable>
        {onAddToRoute ? (
          <Pressable
            style={({ pressed }) => [tpk.routeBtn, pressed && { opacity: layout.pressedOpacity }]}
            onPress={() => onAddToRoute({ id: pick.id, title: pick.place, lat: null, lng: null, sourceType: 'place', sourceId: pick.id, category: pick.tag })}
          >
            <Route size={12} color={color.deep} />
            <Text style={tpk.routeText}>Route</Text>
          </Pressable>
        ) : null}
        <Pressable style={({ pressed }) => [tpk.addBtn, pressed && { opacity: layout.pressedOpacity }]}
          onPress={() => planPicker.open({ id: pick.id, type: 'place', title: pick.place, city: pick.city, category: pick.tag })}>
          <Text style={tpk.addText}>Add to Plan</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [tpk.reportBtn, pressed && { opacity: layout.pressedOpacity }]}
          hitSlop={layout.hitSlop}
          disabled={reported}
          onPress={() => showReportSheet(pick.id, () => setReported(true))}
        >
          <Flag size={13} color={color.mute} />
        </Pressable>
      </View>
    </View>
  );
}

export function TravelerPicksSection({ picks, onAddToRoute }: { picks: TravelerPick[]; onAddToRoute?: (draft: RouteStopDraft) => void }) {
  return (
    <View>
      <TravelSectionHeader title="Traveler Picks" onAction={() => router.push('/saved')} />
      {picks.length === 0 ? (
        <TravelEmptyState title="No traveler picks yet" sub="Recommendations from travelers will show up here." />
      ) : (
        <View style={tpk.strip}>
          {picks.slice(0, 3).map((p) => <TravelerPickCard key={p.id} pick={p} onAddToRoute={onAddToRoute} />)}
        </View>
      )}
    </View>
  );
}

/* ── Saved Ideas ── */
export function SavedIdeasSection({ items }: { items: SavedDiscoveryItem[] }) {
  const planPicker = usePlanPicker();
  return (
    <View>
      <TravelSectionHeader title="Saved Ideas" onAction={() => router.push('/saved')} />
      {items.length === 0 ? (
        <TravelEmptyState title="Nothing saved yet" sub="Save places, gems, and experiences to build your trip." action="Explore the city" onAction={() => router.push('/(tabs)/discovery')} />
      ) : (
        <View style={sv.list}>
          {items.map((it) => (
            <View key={it.id} style={sv.row}>
              <View style={sv.thumb} />
              <View style={{ flex: 1 }}>
                <Text style={sv.name} numberOfLines={1}>{it.name}</Text>
                <Text style={sv.meta} numberOfLines={1}>{it.type} · {it.neighborhood}</Text>
              </View>
              <Pressable style={({ pressed }) => [sv.addBtn, pressed && { opacity: layout.pressedOpacity }]}
                onPress={() => planPicker.open({ id: it.id, type: 'place', title: it.name, city: it.neighborhood, category: it.type })}>
                <Plus size={13} color={color.signal} /><Text style={sv.addText}>Add to Plan</Text>
              </Pressable>
              <Pressable hitSlop={layout.hitSlop} onPress={() => Alert.alert('Coming Soon', 'Saving places is coming in a future update.')}><Bookmark size={17} color={color.signal} fill={color.signal} /></Pressable>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

/* ── Ask Compass card ── */
export function AskCompassCard() {
  const prompts = ['Build a night from these', 'Find more like this', 'Turn saved ideas into a plan', "What matches my vibe?"];
  return (
    <View style={ac.card}>
      <View style={ac.head}>
        <View style={ac.icon}><Sparkles size={18} color={color.onInk} /></View>
        <View style={{ flex: 1 }}>
          <Text style={ac.title}>Ask Compass</Text>
          <Text style={ac.sub}>Turn discoveries into a plan. Uses your saved ideas and interests.</Text>
        </View>
      </View>
      <View style={ac.prompts}>
        {prompts.map((p) => (
          <Pressable key={p} style={({ pressed }) => [ac.prompt, pressed && { opacity: layout.pressedOpacity }]} onPress={() => router.push('/(tabs)/ai')}>
            <Text style={ac.promptText}>{p}</Text>
            <ChevronRight size={14} color={color.signal} />
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/* ─── Styles ─────────────────────────────────────────────────────────────── */

const h = StyleSheet.create({
  wrap: { backgroundColor: color.paper, paddingHorizontal: space.lg, paddingBottom: space.md, borderBottomWidth: 1, borderBottomColor: color.haze },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { ...t.hero, color: color.ink, fontSize: 28 },
  sub: { ...t.small, color: color.mute, marginTop: 1 },
  controls: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.md },
  iconBtn: { width: 42, height: 42, borderRadius: 21, borderWidth: 1, borderColor: color.haze, alignItems: 'center', justifyContent: 'center', backgroundColor: color.paperRaised },
  filterBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: space.md, height: 42, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  filterText: { ...t.bodyStrong, color: color.ink },
  badge: { minWidth: 20, height: 20, borderRadius: 10, backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  badgeText: { ...t.stamp, color: color.onInk, fontFamily: 'Courier' },
  savedBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: space.md, height: 42, borderRadius: radius.pill, borderWidth: 1.5, borderColor: color.signal, backgroundColor: color.paperRaised },
  savedText: { ...t.bodyStrong, color: color.signal },
});

const prov = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  text: { ...t.small, color: color.mute, fontSize: 11, fontStyle: 'italic' },
});

const cp = StyleSheet.create({
  wrap: { flexDirection: 'row', gap: space.md, paddingHorizontal: space.lg },
  hero: { flex: 1.3, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: color.ink, ...shadow.card },
  heroMedia: { height: 90, backgroundColor: color.deep, padding: space.md },
  labelDark: { alignSelf: 'flex-start', backgroundColor: color.signal, paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.sm },
  labelDarkText: { ...t.stamp, color: color.onInk, fontFamily: 'Courier' },
  heroBody: { padding: space.md, gap: 5 },
  heroTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  heroTitle: { ...t.title, color: color.onInk, fontSize: 19 },
  heroSub: { ...t.small, color: color.haze },
  locRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  heroLoc: { ...t.small, color: color.onInk },
  matchRow: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(255,255,255,0.12)', alignSelf: 'flex-start', paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.sm, marginTop: 2 },
  matchText: { ...t.small, color: color.onInk, fontSize: 11 },
  heroBtns: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  ghostBtn: { flex: 1, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingVertical: space.sm, alignItems: 'center' },
  ghostText: { ...t.small, fontWeight: '700', color: color.onInk },
  addBtn: { flex: 1, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 4, backgroundColor: color.signal, borderRadius: radius.md, paddingVertical: space.sm },
  addText: { ...t.small, fontWeight: '800', color: color.onInk },
  sideCol: { flex: 1, gap: space.md },
  sideCard: { flex: 1, flexDirection: 'row', backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, overflow: 'hidden' },
  sideBody: { flex: 1, padding: space.sm, gap: 3 },
  sideTag: { alignSelf: 'flex-start', paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.sm },
  tagGray: { backgroundColor: color.haze },
  tagGreen: { backgroundColor: '#E3F1EA' },
  sideTagText: { fontFamily: 'Courier', fontSize: 7.5, fontWeight: '700', letterSpacing: 0.5 },
  tagGrayText: { color: color.mute },
  tagGreenText: { color: color.success },
  sideTitle: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  sideBlurb: { ...t.small, color: color.mute, fontSize: 11 },
  savedRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2 },
  savedNote: { ...t.small, color: color.mute, fontSize: 10 },
  sideThumb: { width: 60, backgroundColor: color.deep },
});

const cc = StyleSheet.create({
  row: { gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  chipOn: { backgroundColor: color.signal, borderColor: color.signal },
  chipText: { ...t.small, fontWeight: '700', color: color.ink },
  chipTextOn: { color: color.onInk },
});

const fc = StyleSheet.create({
  card: { width: 160, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, overflow: 'hidden', ...shadow.card },
  media: { height: 110, backgroundColor: color.deep, padding: space.sm },
  sparkle: { width: 26, height: 26, borderRadius: 13, backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center' },
  body: { padding: space.md, gap: 3 },
  title: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  sub: { ...t.small, color: color.mute, fontSize: 11 },
  locRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 1 },
  loc: { ...t.small, color: color.mute, fontSize: 11 },
  btnRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.sm },
  addBtn: { flex: 1, borderWidth: 1.5, borderColor: color.signal, borderRadius: radius.sm, paddingVertical: 6, alignItems: 'center' },
  addText: { ...t.small, fontWeight: '800', color: color.signal, fontSize: 12 },
  saveBtn: { padding: 4 },
});

const sh = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, marginTop: space.xl, marginBottom: space.md },
  title: { ...t.title, color: color.ink, fontSize: 20 },
  viewAll: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  viewAllText: { ...t.small, color: color.signal, fontWeight: '700' },
});

const g = StyleSheet.create({
  strip: { gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.xs },
  card: { width: 200, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, overflow: 'hidden', ...shadow.card },
  media: { height: 120, backgroundColor: color.deep, padding: space.sm, justifyContent: 'space-between', flexDirection: 'row' },
  gemBadge: { width: 28, height: 28, borderRadius: 14, backgroundColor: color.success, alignItems: 'center', justifyContent: 'center' },
  saveIcon: { width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(17,17,15,0.4)', alignItems: 'center', justifyContent: 'center' },
  body: { padding: space.md, gap: 3 },
  name: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  locRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  loc: { ...t.small, color: color.mute, fontSize: 11 },
  blurb: { ...t.small, color: color.mute, fontSize: 12, marginTop: 2 },
  byRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4 },
  by: { ...t.small, color: color.mute, fontSize: 11 },
  btnRow: { marginTop: space.sm, flexDirection: 'row', alignItems: 'center', gap: space.xs },
  addBtn: { flex: 1, borderWidth: 1.5, borderColor: color.signal, borderRadius: radius.sm, paddingVertical: 6, alignItems: 'center' },
  addText: { ...t.small, fontWeight: '800', color: color.signal, fontSize: 12 },
  routeBtn: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: space.sm, paddingVertical: 6, borderRadius: radius.sm, borderWidth: 1, borderColor: color.deep },
  routeText: { ...t.small, fontWeight: '700', color: color.deep, fontSize: 11 },
  shareBtn: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm, borderWidth: 1, borderColor: color.haze },
  reportBtn: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm, borderWidth: 1, borderColor: color.haze },
  savedRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2 },
  savedNote: { ...t.small, color: color.mute, fontSize: 10 },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: 1 },
  ratingStar: { fontSize: 10, color: '#F59E0B', lineHeight: 13 },
  ratingValue: { fontSize: 10, color: color.ink, fontWeight: '600' },
});

const nb = StyleSheet.create({
  strip: { gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.xs },
  card: { width: 150, height: 96, borderRadius: radius.md, overflow: 'hidden', backgroundColor: color.ink, ...shadow.card },
  media: { ...StyleSheet.absoluteFillObject, backgroundColor: color.deep },
  overlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end', padding: space.sm, backgroundColor: 'rgba(17,17,15,0.28)' },
  vibe: { ...t.bodyStrong, color: color.onInk, fontSize: 14 },
  area: { ...t.small, color: color.onInkMute, fontSize: 11 },
});

const tpk = StyleSheet.create({
  strip: { gap: space.md, paddingHorizontal: space.lg },
  card: { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md, gap: 6, ...shadow.card },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  user: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  time: { ...t.small, color: color.faint, fontSize: 11 },
  tag: { backgroundColor: color.haze, paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: radius.sm },
  tagText: { ...t.small, color: color.mute, fontWeight: '700', fontSize: 11 },
  placeRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  place: { ...t.bodyStrong, color: color.ink, flex: 1 },
  rating: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  ratingStar: { fontSize: 10, color: '#F59E0B', lineHeight: 13 },
  ratingText: { ...t.small, color: color.ink, fontWeight: '700' },
  note: { ...t.small, color: color.mute },
  btnRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 2 },
  saveBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.sm, borderWidth: 1, borderColor: color.haze },
  saveText: { ...t.small, color: color.mute, fontWeight: '700' },
  addBtn: { flex: 1, borderWidth: 1.5, borderColor: color.signal, borderRadius: radius.sm, paddingVertical: 6, alignItems: 'center' },
  addText: { ...t.small, fontWeight: '800', color: color.signal, fontSize: 12 },
  routeBtn: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: space.sm, paddingVertical: 6, borderRadius: radius.sm, borderWidth: 1, borderColor: color.deep },
  routeText: { ...t.small, fontWeight: '700', color: color.deep, fontSize: 11 },
  reportBtn: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm, borderWidth: 1, borderColor: color.haze },
  savedRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 1 },
  savedNote: { ...t.small, color: color.mute, fontSize: 10 },
});

const sv = StyleSheet.create({
  list: { gap: space.sm, paddingHorizontal: space.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.sm },
  thumb: { width: 44, height: 44, borderRadius: radius.sm, backgroundColor: color.deep },
  name: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  meta: { ...t.small, color: color.mute, fontSize: 11 },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: space.sm, paddingVertical: 6, borderRadius: radius.sm, borderWidth: 1, borderColor: color.haze },
  addText: { ...t.small, fontWeight: '700', color: color.signal, fontSize: 12 },
});

const ac = StyleSheet.create({
  card: { marginHorizontal: space.lg, marginTop: space.xl, backgroundColor: color.ink, borderRadius: radius.lg, padding: space.lg, gap: space.md, ...shadow.card },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  icon: { width: 40, height: 40, borderRadius: 20, backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center' },
  title: { ...t.title, color: color.onInk, fontSize: 18 },
  sub: { ...t.small, color: color.onInkMute, marginTop: 1 },
  prompts: { gap: space.sm },
  prompt: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.md },
  promptText: { ...t.bodyStrong, color: color.onInk, fontSize: 14 },
});
