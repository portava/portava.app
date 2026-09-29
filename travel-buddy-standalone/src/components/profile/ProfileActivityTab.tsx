/**
 * ProfileActivityTab — a person's posts, trips, events and trusted circles on
 * their profile. TM-social, PLAT-F14.
 *
 * Every row comes from GET /api/users/:username/{posts,trips,events,circles}
 * (routes/profileTabs.ts), and every visibility decision is the server's:
 *   - a blocked pair → "not available" (never the rows);
 *   - a deactivated account → "not available";
 *   - a private profile the viewer does not follow, or a show_* opt-out → an
 *     empty page, rendered as "nothing to show" — it never claims the person
 *     has no posts, because the viewer cannot know that;
 *   - a post is only served at a visibility tier the viewer may read.
 * The client additionally hides circle owners in its own blocks context, so a
 * block made a moment ago takes effect without a refetch.
 *
 * Stamps are NOT a sub-tab here: the profile's Stamps tab already renders the
 * v2 stamp inventory, and the legacy /users/:username/stamps route reads a
 * different table (see services/profileTabs.ts).
 *
 * A failed read is "couldn't load" with a retry, never an empty tab (DV-83);
 * a failed "load more" keeps the rows already shown and says so.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { FileText, Plane, CalendarDays, Users } from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import {
  getProfileTabPage,
  type ProfileTabKind, type ProfileTabItemMap,
  type ProfilePostItem, type ProfileTripItem, type ProfileEventItem, type ProfileCircleItem,
} from '../../services/profileTabs.ts';
import { useBlockedIds } from '../../context/BlockedIdsContext.tsx';
import { Avatar } from '../ui/Avatar.tsx';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

const SEGMENTS: { key: ProfileTabKind; label: string; Icon: LucideIcon; empty: string }[] = [
  { key: 'posts',   label: 'Posts',   Icon: FileText,     empty: 'No posts to show.' },
  { key: 'trips',   label: 'Trips',   Icon: Plane,        empty: 'No trips to show.' },
  { key: 'events',  label: 'Events',  Icon: CalendarDays, empty: 'No events to show.' },
  { key: 'circles', label: 'Circles', Icon: Users,        empty: 'No circles to show.' },
];

type SegState<K extends ProfileTabKind> =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'blocked' }
  | { state: 'unavailable' }
  | { state: 'ok'; items: ProfileTabItemMap[K][]; nextCursor: string | null; moreState: 'idle' | 'loading' | 'error' };

function fmtDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function place(city: string | null, country: string | null): string | null {
  return [city, country].filter(Boolean).join(', ') || null;
}

function PostRow({ item }: { item: ProfilePostItem }) {
  const where = place(item.locationCity, item.locationCountry);
  const when = fmtDate(item.createdAt);
  const media = Array.isArray(item.mediaUrls) ? item.mediaUrls.length : 0;
  return (
    <Pressable
      style={s.card}
      onPress={() => router.push(`/post/${item.id}` as never)}
      accessibilityRole="button"
      testID={`profile-post-${item.id}`}
    >
      {item.content ? <Text style={s.body} numberOfLines={3}>{item.content}</Text> : null}
      <Text style={s.meta}>
        {[when, where, media > 0 ? `${media} ${media === 1 ? 'photo' : 'photos'}` : null].filter(Boolean).join(' · ')}
      </Text>
    </Pressable>
  );
}

function TripRow({ item }: { item: ProfileTripItem }) {
  const where = place(item.destinationCity, item.destinationCountry);
  const dates = [fmtDate(item.startDate), fmtDate(item.endDate)].filter(Boolean).join(' – ');
  return (
    <Pressable
      style={s.card}
      onPress={() => router.push(`/trip/${item.id}` as never)}
      accessibilityRole="button"
      testID={`profile-trip-${item.id}`}
    >
      <Text style={s.title} numberOfLines={1}>{item.title ?? where ?? 'Trip'}</Text>
      <Text style={s.meta}>{[where, dates || null].filter(Boolean).join(' · ')}</Text>
    </Pressable>
  );
}

function EventRow({ item }: { item: ProfileEventItem }) {
  const where = place(item.locationCity, item.locationCountry);
  return (
    <Pressable
      style={s.card}
      onPress={() => router.push(`/event/${item.eventId}` as never)}
      accessibilityRole="button"
      testID={`profile-event-${item.eventId}`}
    >
      <Text style={s.title} numberOfLines={1}>{item.title ?? 'Event'}</Text>
      <Text style={s.meta}>
        {[fmtDate(item.startTime), where, item.isHosted ? 'Hosting' : 'Going'].filter(Boolean).join(' · ')}
      </Text>
    </Pressable>
  );
}

function CircleRow({ item }: { item: ProfileCircleItem }) {
  const label = item.ownerDisplayName ?? (item.ownerHandle ? `@${item.ownerHandle}` : 'Traveler');
  return (
    <Pressable
      style={[s.card, s.circleCard]}
      onPress={() => { if (item.ownerHandle) router.push(`/u/${encodeURIComponent(item.ownerHandle)}` as never); }}
      disabled={!item.ownerHandle}
      accessibilityRole="button"
      testID={`profile-circle-${item.circleOwnerId}`}
    >
      <Avatar uri={item.ownerAvatarUrl} name={label.replace(/^@/, '')} size={32} />
      <View style={{ flex: 1 }}>
        <Text style={s.title} numberOfLines={1}>{label}'s circle</Text>
        {fmtDate(item.joinedAt) ? <Text style={s.meta}>Member since {fmtDate(item.joinedAt)}</Text> : null}
      </View>
    </Pressable>
  );
}

export function ProfileActivityTab({ username }: { username: string }) {
  const { blockedIds, blockerIds } = useBlockedIds();
  const [seg, setSeg] = useState<ProfileTabKind>('posts');
  const [data, setData] = useState<SegState<ProfileTabKind>>({ state: 'loading' });
  // Guards against a slow response for the previous segment/user landing last.
  const reqId = useRef(0);

  const loadFirst = useCallback(async (kind: ProfileTabKind) => {
    const id = ++reqId.current;
    setData({ state: 'loading' });
    const page = await getProfileTabPage(kind, username);
    if (id !== reqId.current) return;
    if (page.status === 'ok') setData({ state: 'ok', items: page.items, nextCursor: page.nextCursor, moreState: 'idle' });
    else if (page.status === 'blocked') setData({ state: 'blocked' });
    else if (page.status === 'unavailable') setData({ state: 'unavailable' });
    else setData({ state: 'error' });
  }, [username]);

  useEffect(() => { void loadFirst(seg); }, [seg, loadFirst]);

  async function loadMore() {
    if (data.state !== 'ok' || !data.nextCursor || data.moreState === 'loading') return;
    const id = reqId.current;
    const cursor = data.nextCursor;
    setData({ ...data, moreState: 'loading' });
    const page = await getProfileTabPage(seg, username, cursor);
    if (id !== reqId.current) return;
    setData((prev) => {
      if (prev.state !== 'ok') return prev;
      if (page.status !== 'ok') return { ...prev, moreState: 'error' };
      return { state: 'ok', items: [...prev.items, ...page.items], nextCursor: page.nextCursor, moreState: 'idle' };
    });
  }

  const meta = SEGMENTS.find((x) => x.key === seg)!;
  const visible = data.state === 'ok'
    ? (seg === 'circles'
      ? (data.items as ProfileCircleItem[]).filter((c) => !blockedIds.has(c.circleOwnerId) && !blockerIds.has(c.circleOwnerId))
      : data.items)
    : [];

  return (
    <View style={s.wrap} testID="profile-activity-tab">
      <View style={s.segRow} accessibilityRole="tablist">
        {SEGMENTS.map((x) => {
          const active = x.key === seg;
          return (
            <Pressable
              key={x.key}
              style={[s.seg, active && s.segActive]}
              onPress={() => setSeg(x.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={x.label}
              testID={`profile-activity-seg-${x.key}`}
            >
              <x.Icon size={13} color={active ? color.onInk : color.mute} />
              <Text style={[s.segText, active && s.segTextActive]}>{x.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {data.state === 'loading' ? (
        <ActivityIndicator color={color.signal} style={{ marginVertical: space.lg }} testID="profile-activity-loading" />
      ) : data.state === 'error' ? (
        <View style={s.stateBox}>
          <Text style={s.stateText}>Couldn't load {meta.label.toLowerCase()}.</Text>
          <Pressable onPress={() => { void loadFirst(seg); }} accessibilityRole="button" testID="profile-activity-retry">
            <Text style={s.link}>Try again</Text>
          </Pressable>
        </View>
      ) : data.state === 'blocked' || data.state === 'unavailable' ? (
        <Text style={s.stateText}>This profile isn't available.</Text>
      ) : visible.length === 0 ? (
        <Text style={s.stateText}>{meta.empty}</Text>
      ) : (
        <View style={{ gap: space.sm }}>
          {seg === 'posts' && (visible as ProfilePostItem[]).map((it) => <PostRow key={it.id} item={it} />)}
          {seg === 'trips' && (visible as ProfileTripItem[]).map((it) => <TripRow key={it.id} item={it} />)}
          {seg === 'events' && (visible as ProfileEventItem[]).map((it) => <EventRow key={it.eventId} item={it} />)}
          {seg === 'circles' && (visible as ProfileCircleItem[]).map((it) => <CircleRow key={it.circleOwnerId} item={it} />)}
          {data.nextCursor ? (
            <Pressable style={s.more} onPress={() => { void loadMore(); }} accessibilityRole="button" testID="profile-activity-more">
              {data.moreState === 'loading'
                ? <ActivityIndicator size="small" color={color.signal} />
                : <Text style={s.link}>{data.moreState === 'error' ? "Couldn't load more — try again" : 'Show more'}</Text>}
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { paddingHorizontal: space.lg, gap: space.md },
  segRow: { flexDirection: 'row', gap: space.xs, flexWrap: 'wrap' },
  seg: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.pill,
    borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised,
  },
  segActive: { backgroundColor: color.ink, borderColor: color.ink },
  segText: { ...t.small, color: color.mute, fontWeight: '600' },
  segTextActive: { color: color.onInk },
  card: {
    backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze,
    padding: space.md, gap: 4,
  },
  circleCard: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  body: { ...t.body, color: color.ink, fontSize: 13 },
  meta: { ...t.small, color: color.mute },
  stateBox: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap', paddingVertical: space.md },
  stateText: { ...t.small, color: color.mute, paddingVertical: space.md },
  link: { ...t.small, color: color.signal, fontWeight: '700' },
  more: { alignItems: 'center', paddingVertical: space.sm },
});
