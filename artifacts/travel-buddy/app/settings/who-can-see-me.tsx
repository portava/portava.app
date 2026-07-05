/**
 * Who Can See Me — shows which co-travelers can currently view the user's
 * presence, grouped by context (trip / event).
 *
 * On mount:
 *  1. Fetches user's active trip memberships and event RSVPs from Supabase.
 *  2. Calls GET /api/circle/contexts/:type/:id/who-can-see-me for each.
 *  3. Renders grouped rows.
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet,
  ActivityIndicator, Image,
} from 'react-native';
import { router } from 'expo-router';
import { ArrowLeft, Users, Settings } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { supabase, isSupabaseConfigured } from '../../src/lib/supabase';
import { getCircleSettings, getWhoCanSeeMe, type CircleWatcher } from '../../src/services/circle';
import { useSession } from '../../src/context/SessionContext';

interface ContextGroup {
  contextType: 'trip' | 'event';
  contextId: string;
  label: string;
  watchers: CircleWatcher[];
  error?: string;
}

function AvatarFallback({ name, size = 36 }: { name: string; size?: number }) {
  const initials = name
    .split(' ')
    .map((w) => w[0] ?? '')
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <View style={[af.wrap, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={[af.text, { fontSize: size * 0.4 }]}>{initials || '?'}</Text>
    </View>
  );
}

const af = StyleSheet.create({
  wrap: { backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  text: { color: color.mute, fontWeight: '700' },
});

function WatcherRow({ watcher }: { watcher: CircleWatcher }) {
  return (
    <View style={s.watcherRow}>
      {watcher.avatarUrl ? (
        <Image source={{ uri: watcher.avatarUrl }} style={s.avatar} />
      ) : (
        <AvatarFallback name={watcher.displayName || watcher.username} />
      )}
      <View style={{ flex: 1 }}>
        <Text style={s.watcherName}>{watcher.displayName || watcher.username}</Text>
        {watcher.username ? <Text style={s.watcherHandle}>@{watcher.username}</Text> : null}
      </View>
    </View>
  );
}

export default function WhoCanSeeMeScreen() {
  const insets = useSafeAreaInsets();
  const { isAuthed, configured, userId } = useSession();
  const live = configured && isAuthed && Boolean(userId);

  const [loading, setLoading] = useState(true);
  const [globalOff, setGlobalOff] = useState(false);
  const [groups, setGroups] = useState<ContextGroup[]>([]);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    if (!live || !userId) { setLoading(false); return; }
    setLoading(true);
    setLoadError(false);

    try {
      const settingsRes = await getCircleSettings();
      if (settingsRes.ok && !settingsRes.data.globalEnabled) {
        setGlobalOff(true);
        setLoading(false);
        return;
      }
      setGlobalOff(false);

      const [tripsRes, eventsRes] = await Promise.all([
        isSupabaseConfigured
          ? supabase
              .from('trip_members')
              .select('trip_id, trips:trip_id(id, title, destination, end_date)')
              .eq('user_id', userId)
              .in('role', ['owner', 'co_host', 'member', 'viewer'])
          : Promise.resolve({ data: [], error: null }),
        isSupabaseConfigured
          ? supabase
              .from('event_rsvps')
              .select('event_id, events:event_id(id, name, ends_at)')
              .eq('user_id', userId)
              .eq('status', 'going')
          : Promise.resolve({ data: [], error: null }),
      ]);

      const now = new Date();

      const tripContexts: Array<{ contextType: 'trip'; contextId: string; label: string }> = (
        (tripsRes.data ?? []) as any[]
      )
        .filter((r) => {
          const endDate = (r.trips as any)?.end_date;
          if (!endDate) return true;
          return new Date(endDate + 'T23:59:59Z') >= now;
        })
        .map((r) => ({
          contextType: 'trip' as const,
          contextId: r.trip_id as string,
          label: ((r.trips as any)?.title as string) || ((r.trips as any)?.destination as string) || 'Trip',
        }));

      const eventContexts: Array<{ contextType: 'event'; contextId: string; label: string }> = (
        (eventsRes.data ?? []) as any[]
      )
        .filter((r) => {
          const endsAt = (r.events as any)?.ends_at;
          if (!endsAt) return true;
          return new Date(endsAt) >= now;
        })
        .map((r) => ({
          contextType: 'event' as const,
          contextId: r.event_id as string,
          label: ((r.events as any)?.name as string) || 'Event',
        }));

      const allContexts = [...tripContexts, ...eventContexts];

      const results = await Promise.all(
        allContexts.map(async (ctx) => {
          const res = await getWhoCanSeeMe(ctx.contextType, ctx.contextId);
          if (res.ok) {
            return { ...ctx, watchers: res.data.members, error: undefined as string | undefined };
          }
          if (res.status === 403) {
            return { ...ctx, watchers: [] as CircleWatcher[], error: 'not_sharing' as string | undefined };
          }
          return { ...ctx, watchers: [] as CircleWatcher[], error: res.error as string | undefined };
        }),
      );

      setGroups(results.filter((g) => g.error !== 'not_sharing' && g.error !== 'feature_disabled'));
    } catch {
      setLoadError(true);
    }

    setLoading(false);
  }, [live, userId]);

  useEffect(() => { load(); }, [load]);

  const totalWatchers = groups.reduce((sum, g) => sum + g.watchers.length, 0);

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Pressable onPress={() => router.back()} style={s.backBtn}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={s.headerTitle}>Who can see me?</Text>
      </View>

      {loading ? (
        <View style={s.center}>
          <ActivityIndicator color={color.deep} />
        </View>
      ) : loadError ? (
        <View style={s.center}>
          <Text style={s.errorText}>Failed to load. Check your connection.</Text>
          <Pressable style={s.retryBtn} onPress={load}>
            <Text style={s.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : globalOff ? (
        <View style={s.center}>
          <View style={s.emptyIcon}>
            <Users size={32} color={color.faint} />
          </View>
          <Text style={s.emptyTitle}>Find Your Circle is off</Text>
          <Text style={s.emptyBody}>
            No one can see you right now. Turn on Find Your Circle in settings to start sharing.
          </Text>
          <Pressable
            style={s.settingsBtn}
            onPress={() => router.push('/settings/find-your-circle' as any)}
          >
            <Settings size={16} color={color.onInk} />
            <Text style={s.settingsBtnText}>Open Circle settings</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + space.xl }}>
          {groups.length === 0 ? (
            <View style={s.center}>
              <View style={s.emptyIcon}>
                <Users size={32} color={color.faint} />
              </View>
              <Text style={s.emptyTitle}>No one can see you right now</Text>
              <Text style={s.emptyBody}>
                You're not actively sharing in any trip or event circle, or no co-travelers have Circle enabled.
              </Text>
            </View>
          ) : (
            <>
              <View style={s.summaryBanner}>
                <Text style={s.summaryText}>
                  {totalWatchers === 0
                    ? 'No co-travelers can see your status right now.'
                    : totalWatchers === 1
                    ? '1 co-traveler can currently see your status.'
                    : `${totalWatchers} co-travelers can currently see your status.`}
                </Text>
              </View>

              {groups.map((group) => (
                <View key={`${group.contextType}:${group.contextId}`} style={s.group}>
                  <View style={s.groupHeader}>
                    <Text style={s.groupType}>
                      {group.contextType === 'trip' ? 'TRIP' : 'EVENT'}
                    </Text>
                    <Text style={s.groupLabel}>{group.label}</Text>
                  </View>

                  {group.watchers.length === 0 ? (
                    <View style={s.groupEmpty}>
                      <Text style={s.groupEmptyText}>
                        No co-travelers can see you in this {group.contextType} yet.
                      </Text>
                    </View>
                  ) : (
                    <View style={s.watcherList}>
                      {group.watchers.map((w) => (
                        <WatcherRow key={w.userId} watcher={w} />
                      ))}
                    </View>
                  )}
                </View>
              ))}
            </>
          )}

          <View style={s.bottomActions}>
            <Pressable
              style={s.circleSettingsBtn}
              onPress={() => router.push('/settings/find-your-circle' as any)}
            >
              <Settings size={16} color={color.deep} />
              <Text style={s.circleSettingsBtnText}>Circle settings</Text>
            </Pressable>
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.paper,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    gap: space.md,
  },
  backBtn: {
    padding: space.xs,
    marginLeft: -space.xs,
  },
  headerTitle: {
    ...t.heading,
    color: color.ink,
    fontSize: 18,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    gap: space.md,
  },
  errorText: {
    ...t.body,
    color: color.mute,
    textAlign: 'center',
  },
  retryBtn: {
    paddingHorizontal: space.xl,
    paddingVertical: space.sm,
    backgroundColor: color.deep,
    borderRadius: radius.md,
  },
  retryText: {
    ...t.bodyStrong,
    color: color.onInk,
    fontSize: 14,
  },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: radius.lg,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: {
    ...t.bodyStrong,
    color: color.ink,
    textAlign: 'center',
  },
  emptyBody: {
    ...t.small,
    color: color.mute,
    textAlign: 'center',
    lineHeight: 18,
  },
  settingsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.deep,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm + 2,
    marginTop: space.sm,
  },
  settingsBtnText: {
    ...t.bodyStrong,
    color: color.onInk,
    fontSize: 14,
  },
  summaryBanner: {
    backgroundColor: '#EAF2F4',
    marginHorizontal: space.lg,
    marginTop: space.lg,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  summaryText: {
    ...t.small,
    color: color.deep,
    textAlign: 'center',
    fontWeight: '600',
  },
  group: {
    marginTop: space.xl,
    marginHorizontal: space.lg,
  },
  groupHeader: {
    marginBottom: space.sm,
  },
  groupType: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: color.faint,
    marginBottom: 2,
  },
  groupLabel: {
    ...t.bodyStrong,
    color: color.ink,
  },
  groupEmpty: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  groupEmptyText: {
    ...t.small,
    color: color.mute,
  },
  watcherList: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    overflow: 'hidden',
  },
  watcherRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
  },
  watcherName: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 14,
  },
  watcherHandle: {
    ...t.small,
    color: color.mute,
    marginTop: 1,
  },
  bottomActions: {
    marginHorizontal: space.lg,
    marginTop: space.xl,
    gap: space.sm,
  },
  circleSettingsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    borderWidth: 1,
    borderColor: color.deep,
    borderRadius: radius.md,
    paddingVertical: space.md,
  },
  circleSettingsBtnText: {
    ...t.bodyStrong,
    color: color.deep,
    fontSize: 14,
  },
});
