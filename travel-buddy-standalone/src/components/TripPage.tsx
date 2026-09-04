import React, { useState, useEffect, Component, type ErrorInfo, type ReactNode } from 'react';
import { View, Text, Image, Pressable, ScrollView, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import { Avatar } from './ui/Avatar.tsx';
import { CachedImage } from './CachedImage.tsx';
import { fallbackUriFor } from '../lib/visuals/fallbackAssets.ts';
import { SharedVideoPlayer } from './ui/SharedVideoPlayer.tsx';
import { router } from 'expo-router';
import Svg, { Path } from 'react-native-svg';
import {
  CalendarDays, User as UserIcon, Clock, MapPin, CheckCircle2, Circle as CircleIcon,
  CalendarPlus, UserPlus, Sparkles, Settings, Bookmark, Plus, ChevronRight, Plane,
  Map as MapIcon,
  MessageCircle, ShieldCheck, ImagePlus, Info, X, Bell,
} from 'lucide-react-native';
import { useTripSavedPlaces } from '../hooks/useTripSavedPlaces.ts';
import { fetchCompassTripBrief, reportCompassViewed, type CompassRecommendation } from '../services/compass.ts';
import { resolveCompassTitle, formatCompassSubtitle } from '../utils/compassFormat.ts';
import { openTripChat } from '../services/messaging.ts';
import { createPlanItem } from '../services/tripPlan.ts';
import type { BookmarkedPlace } from '../services/discoveryBookmarks.ts';
import type { TripDetail, SavedIdea, TimelineDay, PassportStamp, User } from '../types/models.ts';
import type { TripPlan, TripPlanStatus } from '../__fixtures__/tripDetail.ts';
import { color, space, radius, type as t, shadow, layout, avatar, icon, dot } from '../theme/tokens.ts';
import { fromISODate } from '../lib/dateTime/formatters.ts';
import { PassportStampCard } from './PassportStampCard.tsx';
import { TravelSectionHeader, TravelEmptyState } from './primitives.tsx';
import { HighlightRing } from './HighlightRing.tsx';
import { HighlightViewer } from './HighlightViewer.tsx';
import { AddToPlanSheet } from './AddToPlanSheet.tsx';
import { useHighlightRingState } from '../hooks/useHighlightRingState.ts';
import { deriveTripDisplayStatus, tripStatusLabel } from '../lib/tripStatus.ts';

/* ── Progress ring (semicircle arc) ── */
function ProgressRing({ pct }: { pct: number }) {
  const r = 46, cx = 60, cy = 60;
  const start = Math.PI;
  const end = Math.PI - (pct / 100) * Math.PI;
  const x1 = cx + r * Math.cos(start), y1 = cy - r * Math.sin(start);
  const x2 = cx + r * Math.cos(end), y2 = cy - r * Math.sin(end);
  const bgX = cx + r * Math.cos(0), bgY = cy - r * Math.sin(0);
  return (
    <View style={{ alignItems: 'center' }}>
      <Svg width={120} height={70} viewBox="0 0 120 70">
        <Path d={`M ${x1} ${y1} A ${r} ${r} 0 0 1 ${bgX} ${bgY}`} stroke={color.haze} strokeWidth="9" fill="none" strokeLinecap="round" />
        <Path d={`M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`} stroke={color.signal} strokeWidth="9" fill="none" strokeLinecap="round" />
      </Svg>
      <Text style={ring.pct}>{pct}%</Text>
    </View>
  );
}

/* ── Trip hero header ── */
export function TripHero({ trip }: { trip: TripDetail }) {
  const [addPlanOpen, setAddPlanOpen] = useState(false);
  const hasDates = !!(trip.startDate && trip.endDate);
  const dates = hasDates
    ? `${fmt(trip.startDate)} – ${fmt(trip.endDate)}, ${new Date(trip.endDate).getFullYear()}`
    : null;
  // Derive from end date rather than trusting the stored status column, which
  // is only recomputed on writes and can go stale once a trip's dates pass.
  const displayStatus = deriveTripDisplayStatus(trip.status, trip.endDate);
  return (
    <View style={hero.wrap}>
      <View style={hero.imageCard}>
        {trip.coverMediaType === 'video' && trip.coverUrl ? (
          <SharedVideoPlayer uri={trip.coverUrl} autoplay muted loop style={hero.imageBg} />
        ) : trip.coverUrl ? (
          <CachedImage source={{ uri: trip.coverUrl }} style={hero.imageBg} resizeMode="cover" />
        ) : (
          <View style={hero.imageBg}>
            {/* Category fallback image — landmark gives an attractive travel backdrop */}
            {(() => {
              const fb = fallbackUriFor('landmark');
              return fb ? (
                <Image source={{ uri: fb }} style={StyleSheet.absoluteFill} resizeMode="cover" />
              ) : null;
            })()}
            <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(17,17,15,0.35)' }]} />
            <View style={hero.stampMark}><Plane size={16} color={color.onInk} /><Text style={hero.stampText}>{(trip.destinationCity ?? 'Trip').toUpperCase()}</Text></View>
          </View>
        )}
        <View style={hero.identity}>
          <View style={hero.titleRow}>
            <Text style={hero.title}>{trip.title}</Text>
            <View style={hero.activeChip}><Text style={hero.activeText}>{tripStatusLabel(displayStatus)}</Text></View>
          </View>
          <Text style={hero.dest}>{trip.destinationCity}, {trip.destinationCountry}</Text>
          <View style={hero.metaRow}><CalendarDays size={14} color={color.onInk} /><Text style={hero.meta}>{dates ? `${dates} (${trip.nights} nights)` : 'No dates yet'}</Text></View>
          <View style={hero.metaRow}>
            <UserIcon size={14} color={color.onInk} />
            <Text style={hero.meta}>{trip.travelStyle} · {trip.openToMeet ? 'Open to Meet' : 'Private'}</Text>
            {trip.openToMeet && <View style={hero.openChip}><Text style={hero.openText}>Open</Text></View>}
          </View>
          {trip.availabilityLabel ? (
            <View style={hero.availChip}><Clock size={13} color={color.onInk} /><Text style={hero.availText}>{trip.availabilityLabel}</Text></View>
          ) : null}
        </View>
      </View>

      <View style={hero.actions}>
        <Action icon={<CalendarPlus size={18} color={color.signal} />} label="Add Plan" onPress={() => setAddPlanOpen(true)} />
        <Action icon={<UserPlus size={18} color={color.ink} />} label="Invite Buddy" onPress={() => router.push(`/circle?tripId=${encodeURIComponent(trip.id)}` as any)} />
        <Action icon={<Sparkles size={18} color={color.signal} />} label="Ask Compass" onPress={() => router.push('/(tabs)/ai')} />
        <Action icon={<Settings size={18} color={color.ink} />} label="Trip Settings" onPress={() => router.push({ pathname: '/trip/edit', params: { id: trip.id } } as any)} />
      </View>

      <View style={hero.progressCard}>
        <Text style={hero.progressTitle}>Trip Progress</Text>
        <ProgressRing pct={trip.progress} />
        <Text style={hero.progressSub}>Your trip is coming together!</Text>
        <View style={{ gap: space.sm, marginTop: space.md, alignSelf: 'stretch' }}>
          {trip.progressSteps.map((s) => (
            <View key={s.label} style={hero.stepRow}>
              {s.done ? <CheckCircle2 size={18} color={color.success} /> : <CircleIcon size={18} color={color.faint} />}
              <Text style={[hero.stepText, s.done && hero.stepDone]}>{s.label}</Text>
            </View>
          ))}
        </View>
      </View>
      {/* Plan composer sheet — Modal renders as an overlay, safe inside hero.wrap */}
      <AddToPlanSheet
        visible={addPlanOpen}
        tripId={trip.id}
        onClose={() => setAddPlanOpen(false)}
        onAdded={() => setAddPlanOpen(false)}
      />
    </View>
  );
}

function Action({ icon, label, onPress }: { icon: React.ReactNode; label: string; onPress: () => void }) {
  return (
    <Pressable style={hero.action} onPress={onPress}>
      {icon}
      <Text style={hero.actionText}>{label}</Text>
    </Pressable>
  );
}

/* ── Today / Next Up ── */
export function TodayNextUp({ nextUp, tripId, action }: {
  nextUp: any | null;
  tripId?: string;
  /** Next-best-action payload from useNextBestAction (Trip Brain wave). */
  action?: {
    title: string;
    detail: string | null;
    category: string;
    severity: string;
    dueAt: string | null;
  } | null;
}) {
  return (
    <View style={section.wrap}>
      <SectionHead title="Today / Next Up" onViewAll={nextUp ? () => router.push('/(tabs)/trips') : undefined} />
      {!nextUp && action ? (
        // Next-best-action card (readiness-driven; server flag-gated — absent flag
        // means `action` is null and the empty state below renders as before).
        <View style={nx.card}>
          <View style={nx.body}>
            <View style={nx.badgeRow}>
              <View style={nx.badge}><Text style={nx.badgeText}>{(action.category ?? 'next').toUpperCase()}</Text></View>
              {action.dueAt ? <Text style={nx.time}>{new Date(action.dueAt).toLocaleDateString()}</Text> : null}
            </View>
            <Text style={nx.title}>{action.title}</Text>
            {action.detail ? (
              <View style={nx.metaRow}><Text style={nx.meta}>{action.detail}</Text></View>
            ) : null}
            <View style={nx.btns}>
              <Pressable style={nx.primary} onPress={() => router.push('/(tabs)/trips')}><Text style={nx.primaryText}>View Plan</Text></Pressable>
              <Pressable style={nx.ghost} onPress={() => router.push('/(tabs)/ai')}><Text style={nx.ghostText}>Ask Compass</Text></Pressable>
            </View>
          </View>
        </View>
      ) : !nextUp ? (
        <View style={nx.empty}>
          <Text style={nx.emptyText}>Nothing planned yet. Add a plan or ask Compass to build your first night.</Text>
          <Pressable style={nx.emptyBtn} onPress={() => router.push('/(tabs)/ai')}><Text style={nx.emptyBtnText}>Ask Compass</Text></Pressable>
        </View>
      ) : (
        <View style={nx.card}>
          <View style={nx.media} />
          <View style={nx.body}>
            <View style={nx.badgeRow}>
              <View style={nx.badge}><Text style={nx.badgeText}>{nextUp.badge}</Text></View>
              <Text style={nx.time}>{nextUp.time}</Text>
            </View>
            <Text style={nx.title}>{nextUp.title}</Text>
            <View style={nx.metaRow}><MapPin size={13} color={color.mute} /><Text style={nx.meta}>{nextUp.place}</Text></View>
            <View style={nx.hostRow}>
              <Avatar uri={nextUp.host.avatarUrl} name={nextUp.host.name} size={20} />
              <Text style={nx.host}>Hosted by {nextUp.host.name.split(' ')[0]}</Text>
            </View>
            <View style={nx.attRow}>
              <AvatarRow people={nextUp.attendees} />
              <Text style={nx.going}>{nextUp.attendeeCount} going</Text>
            </View>
            <View style={nx.btns}>
              <Pressable style={nx.primary} onPress={() => router.push('/(tabs)/trips')}><Text style={nx.primaryText}>View Plan</Text></Pressable>
              <Pressable
                style={nx.ghost}
                onPress={async () => {
                  if (!tripId) { router.push('/(tabs)/messages' as any); return; }
                  const res = await openTripChat(tripId);
                  if (res.ok && res.data?.threadId) {
                    router.push(`/messages/${res.data.threadId}?threadType=trip&contextId=${encodeURIComponent(tripId)}` as any);
                  } else {
                    router.push('/(tabs)/messages' as any);
                  }
                }}
              >
                <Text style={nx.ghostText}>Message Group</Text>
              </Pressable>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

function AvatarRow({ people }: { people: any[] }) {
  return (
    <View style={{ flexDirection: 'row' }}>
      {people.slice(0, 4).map((u, i) => (
        <Avatar key={u.id} uri={u.avatarUrl} name={u.name} size={22} style={[nx.attAvatarRing, { marginLeft: i === 0 ? 0 : -9, zIndex: 4 - i }]} />
      ))}
    </View>
  );
}

/* ── Trip Timeline ── */
export function TripTimeline({ days }: { days: TimelineDay[] }) {
  const [active, setActive] = useState(0);
  const day = days[active] ?? days[0];
  return (
    <View style={section.wrap}>
      <SectionHead title="Trip Timeline" />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={tl.dayRow}>
        {days.map((d, i) => (
          <Pressable key={d.iso} style={[tl.dayTab, i === active && tl.dayTabOn]} onPress={() => setActive(i)}>
            <Text style={[tl.dayLabel, i === active && tl.dayLabelOn]}>{d.dateLabel}</Text>
            <Text style={[tl.daySub, i === active && tl.dayLabelOn]}>{d.dateSub}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <View style={tl.items}>
        {day.items.length === 0 ? (
          <Text style={tl.empty}>No plans this day yet. Add one or ask Compass.</Text>
        ) : day.items.map((it) => (
          <View key={it.id} style={tl.item}>
            <View style={tl.timeCol}>
              <Text style={tl.itemTime}>{it.time}</Text>
              <View style={[tl.dot, it.kind === 'free' && tl.dotOpen]} />
            </View>
            <View style={[tl.itemCard, it.kind === 'free' && tl.itemFree]}>
              <Text style={tl.itemTitle}>{it.title}</Text>
              {it.place ? <Text style={tl.itemPlace}>{it.place}</Text> : null}
              {it.attendeeCount ? <Text style={tl.itemGoing}>{it.attendeeCount} going</Text> : null}
            </View>
          </View>
        ))}
      </View>
      <Pressable style={tl.viewFull} onPress={() => router.push('/(tabs)/trips')}>
        <Text style={tl.viewFullText}>View full itinerary</Text>
        <ChevronRight size={15} color={color.signal} />
      </Pressable>
    </View>
  );
}

/* ── Saved Ideas ── */
export function SavedIdeas({ ideas }: { ideas: SavedIdea[]; tripId: string }) {
  const CAT_TONE: Record<string, { bg: string; fg: string }> = {
    Food: { bg: '#FCE9E4', fg: color.signal },
    Nightlife: { bg: '#EFE7FA', fg: '#7A4DBF' },
    Nature: { bg: '#E3F1EA', fg: color.success },
    Beach: { bg: '#E2EDF0', fg: color.deep },
  };
  const hasAny = ideas.length > 0;
  return (
    <View style={section.wrap}>
      <SectionHead title="Saved Ideas" onViewAll={hasAny ? () => router.push('/saved') : undefined} />
      {!hasAny ? (
        <View style={si.empty}><Text style={si.emptyText}>Save places from the Discovery Wall to build this trip.</Text></View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={si.strip}>
          {ideas.map((idea) => {
            const tone = CAT_TONE[idea.category] ?? { bg: color.haze, fg: color.mute };
            return (
              <View key={idea.id} style={si.card}>
                <View style={si.media}>
                  <View style={si.bookmark}><Bookmark size={15} color={color.onInk} fill={color.onInk} /></View>
                </View>
                <View style={si.body}>
                  <Text style={si.name} numberOfLines={1}>{idea.name}</Text>
                  <Text style={si.hood} numberOfLines={1}>{idea.neighborhood}</Text>
                  <View style={[si.cat, { backgroundColor: tone.bg }]}><Text style={[si.catText, { color: tone.fg }]}>{idea.category}</Text></View>
                </View>
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

/* ── Trip Saved Places ──────────────────────────────────────────────────────
 * Shows bookmarked Discovery places in the context of a specific trip.
 * The X button uses remove() for an optimistic delete with rollback: the item
 * disappears instantly and reappears with an error alert if storage fails.
 * The full toggle is still available for add/remove via the TripWishlistPicker.
 * ─────────────────────────────────────────────────────────────────────────── */
export function TripSavedPlacesSection({ tripId }: { tripId: string }) {
  const { places, loading, remove, clearAll } = useTripSavedPlaces(tripId);

  const handleClearAll = () => {
    Alert.alert(
      'Clear all saved places?',
      'This will remove all places from your wishlist. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear all',
          style: 'destructive',
          onPress: () => {
            clearAll().catch(() => {
              Alert.alert('Something went wrong', "Couldn't clear your saved places. Please try again.");
            });
          },
        },
      ],
    );
  };

  return (
    <View style={section.wrap}>
      <SectionHead
        title="Saved Places"
        onViewAll={places.length > 0 ? () => router.push('/saved') : undefined}
        onClearAll={places.length > 0 ? handleClearAll : undefined}
      />
      {loading ? (
        <View style={tsp.center}>
          <ActivityIndicator size="small" color={color.signal} />
        </View>
      ) : places.length === 0 ? (
        <View style={tsp.empty}>
          <Text style={tsp.emptyText}>
            No places saved yet — explore Discovery to add some.
          </Text>
        </View>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={tsp.strip}
        >
          {places.map((place: BookmarkedPlace) => (
            <View key={place.id} style={tsp.card}>
              <View style={tsp.cardIcon}>
                <MapPin size={14} color={color.signal} />
              </View>
              <View style={tsp.cardBody}>
                <Text style={tsp.name} numberOfLines={1}>{place.name}</Text>
                {place.category ? (
                  <Text style={tsp.category} numberOfLines={1}>{place.category}</Text>
                ) : null}
                {place.address ? (
                  <Text style={tsp.address} numberOfLines={1}>{place.address}</Text>
                ) : null}
              </View>
              <Pressable
                testID={`saved-place-remind-${place.id}`}
                style={tsp.removeBtn}
                hitSlop={8}
                onPress={() => {
                  router.push(
                    `/reminders/new?targetType=saved_place&targetId=${encodeURIComponent(place.id)}&targetLabel=${encodeURIComponent(place.name)}` as any,
                  );
                }}
                accessibilityLabel={`Remind me about ${place.name}`}
              >
                <Bell size={13} color={color.mute} />
              </Pressable>
              <Pressable
                testID={`saved-place-remove-${place.id}`}
                style={tsp.removeBtn}
                hitSlop={8}
                onPress={() => {
                  remove(place).catch(() => {
                    Alert.alert('Something went wrong', "Couldn't remove this place. Please try again.");
                  });
                }}
                accessibilityLabel={`Remove ${place.name} from saved places`}
              >
                <X size={13} color={color.mute} />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const tsp = StyleSheet.create({
  center: {
    height: 60,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  emptyText: {
    ...t.body,
    color: color.faint,
    fontSize: 13,
  },
  strip: {
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    paddingVertical: space.sm,
    paddingLeft: space.sm,
    paddingRight: space.xs,
    maxWidth: 200,
    minWidth: 120,
  },
  cardIcon: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: `${color.signal}12`,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  cardBody: {
    flex: 1,
    gap: 2,
  },
  name: {
    ...t.bodyStrong,
    fontSize: 13,
    color: color.ink,
  },
  category: {
    ...t.small,
    fontSize: 11,
    color: color.mute,
    textTransform: 'capitalize',
  },
  address: {
    ...t.small,
    fontSize: 11,
    color: color.faint,
  },
  removeBtn: {
    width: icon.s24,
    height: icon.s24,
    borderRadius: icon.s24 / 2,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
});

/* shared section header */
export function SectionHead({
  title,
  onViewAll,
  onClearAll,
}: {
  title: string;
  onViewAll?: () => void;
  onClearAll?: () => void;
}) {
  return (
    <View style={section.head}>
      <Text style={section.title}>{title}</Text>
      <View style={{ flex: 1 }} />
      {onClearAll && (
        <Pressable style={section.clearAll} onPress={onClearAll} hitSlop={6}>
          <Text style={section.clearAllText}>Clear all</Text>
        </Pressable>
      )}
      {onViewAll && (
        <Pressable style={section.viewAll} onPress={onViewAll} hitSlop={6}>
          <Text style={section.viewAllText}>View all</Text>
          <ChevronRight size={15} color={color.signal} />
        </Pressable>
      )}
    </View>
  );
}

function fmt(iso: string) {
  return (fromISODate(iso) ?? new Date(iso)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1); }

/* ─────────────────────────────────────────────────────────────────────────────
   TripPage2 exports — merged here so TripPage is the single canonical file.
   ───────────────────────────────────────────────────────────────────────────── */

const PLAN_TABS: { key: TripPlanStatus; label: string }[] = [
  { key: 'joined', label: 'Joined' },
  { key: 'hosting', label: 'Hosting' },
  { key: 'requested', label: 'Requested' },
  { key: 'past', label: 'Past' },
  { key: 'saved', label: 'Saved' },
];

/* ── Plans ── */
export function TripPlans({ plans, tripId }: { plans: TripPlan[]; tripId?: string }) {
  const [tab, setTab] = useState<TripPlanStatus>('joined');
  const [addPlanOpen, setAddPlanOpen] = useState(false);
  const visible = plans.filter((p) => p.status === tab);
  return (
    <View>
      <TravelSectionHeader title="Plans" onAction={() => router.push('/(tabs)/trips')} actionLabel="View all" />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={pl.tabs}>
        {PLAN_TABS.map((tb) => (
          <Pressable key={tb.key} style={[pl.tab, tab === tb.key && pl.tabOn]} onPress={() => setTab(tb.key)}>
            <Text style={[pl.tabText, tab === tb.key && pl.tabTextOn]}>{tb.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
      {visible.length === 0 ? (
        <>
          <TravelEmptyState
            title="No trip plans yet"
            sub="Add your first plan to start building your itinerary."
            action={tripId ? 'Add a Plan' : undefined}
            onAction={tripId ? () => setAddPlanOpen(true) : undefined}
          />
          {tripId ? (
            <AddToPlanSheet
              visible={addPlanOpen}
              tripId={tripId}
              onClose={() => setAddPlanOpen(false)}
              onAdded={() => setAddPlanOpen(false)}
            />
          ) : null}
        </>
      ) : (
        <View style={pl.list}>
          {visible.map((plan) => (
            <View key={plan.id} style={pl.card}>
              <View style={pl.media} />
              <View style={pl.body}>
                <Text style={pl.title} numberOfLines={1}>{plan.title}</Text>
                <View style={pl.line}><Clock size={12} color={color.mute} /><Text style={pl.lineText}>{plan.time}</Text></View>
                <View style={pl.line}><MapPin size={12} color={color.mute} /><Text style={pl.lineText} numberOfLines={1}>{plan.neighborhood}</Text></View>
                <Text style={pl.going}>{plan.attendeeCount} going</Text>
              </View>
              <View style={pl.actions}>
                <Pressable style={pl.viewBtn} onPress={() => router.push('/(tabs)/trips')}><Text style={pl.viewText}>View Plan</Text></Pressable>
                {plan.hasGroup ? (
                  <Pressable
                    style={pl.msgBtn}
                    hitSlop={layout.hitSlop}
                    onPress={async () => {
                      if (!tripId) { router.push('/(tabs)/messages' as any); return; }
                      const res = await openTripChat(tripId);
                      if (res.ok && res.data?.threadId) {
                        router.push(`/messages/${res.data.threadId}?threadType=trip&contextId=${encodeURIComponent(tripId)}` as any);
                      } else {
                        router.push('/(tabs)/messages' as any);
                      }
                    }}
                  >
                    <MessageCircle size={15} color={color.mute} />
                  </Pressable>
                ) : null}
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

/* ── Member avatar with highlight ring ── */
function MemberAvatar({ u, currentUserId }: { u: User; currentUserId?: string | null }) {
  const ringState = useHighlightRingState(u.id);
  const [viewerOpen, setViewerOpen] = useState(false);

  const img = <Avatar uri={u.avatarUrl} name={u.name} size={48} />;

  if (!ringState?.hasActive) {
    return (
      <Pressable key={u.id} onPress={() => router.push(`/profile/${u.handle}`)} style={cr.avatarWrap}>
        {img}
        <View style={cr.onlineDot} />
      </Pressable>
    );
  }

  return (
    <>
      <Pressable style={cr.avatarWrap} onPress={() => router.push(`/profile/${u.handle}`)}>
        <HighlightRing size={48} hasActive allViewed={ringState.allViewed} onPress={() => setViewerOpen(true)}>
          {img}
        </HighlightRing>
        <View style={cr.onlineDot} />
      </Pressable>
      <HighlightViewer
        visible={viewerOpen}
        highlights={ringState.highlights}
        currentUserId={currentUserId ?? undefined}
        onClose={() => setViewerOpen(false)}
      />
    </>
  );
}

/* ── Trip Circle ── */
export function TripCircle({ cityCount, inCity, suggested, currentUserId, tripId, city }: { cityCount: number; inCity: User[]; suggested: User[]; currentUserId?: string | null; tripId?: string; city?: string }) {
  // Object-form href (pathname + params), matching the pattern used elsewhere
  // in this file (e.g. circle-context-settings below) — a raw string href
  // with a hand-encoded query string is not guaranteed to resolve reliably
  // under Expo Router's typed-routes navigator, which expects params to be
  // passed separately from the pathname.
  const goToCircle = () =>
    router.push(tripId ? ({ pathname: '/circle', params: { tripId } } as any) : ('/circle' as any));
  return (
    <View>
      <TravelSectionHeader title="Trip Circle" onAction={goToCircle} actionLabel="View all" />
      <View style={cr.card}>
        <Text style={cr.count}>{cityCount} {cityCount === 1 ? 'buddy' : 'buddies'} near {city ?? 'your destination'}</Text>
        <View style={cr.avatars}>
          {inCity.map((u) => (
            <MemberAvatar key={u.id} u={u} currentUserId={currentUserId} />
          ))}
          <Pressable style={cr.inviteBtn} onPress={goToCircle}>
            <UserPlus size={16} color={color.signal} />
          </Pressable>
        </View>
        <Pressable style={cr.inviteRow} onPress={goToCircle}>
          <Plus size={14} color={color.signal} /><Text style={cr.inviteText}>Invite more buddies</Text>
        </Pressable>
        <View style={cr.divider} />
        <Text style={cr.suggestLabel}>People you may want to connect with</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={cr.suggestRow}>
          {suggested.map((u) => (
            <Pressable key={u.id} onPress={() => router.push(`/profile/${u.handle}`)}>
              <Avatar uri={u.avatarUrl} name={u.name} size={40} />
            </Pressable>
          ))}
          <Pressable style={cr.suggestMore} onPress={goToCircle}><ChevronRight size={18} color={color.mute} /></Pressable>
        </ScrollView>
      </View>
    </View>
  );
}

/* ── Compass Trip Brief ── */

interface CompassTripBriefProps {
  tripId?: string;
  city?: string;
  startDate?: string;
  endDate?: string;
}

const TYPE_ICONS: Record<string, string> = {
  event: '🗓',
  place: '📍',
  hidden_gem: '💎',
  stamp: '🛂',
};

// ── Error boundary for Compass Trip Brief ────────────────────────────────────
// Prevents any unexpected render error inside the brief from crashing the whole
// trip detail screen.

export class CompassBriefErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError(_error: Error) {
    return { hasError: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Silently suppress — brief errors should never surface to the user
  }

  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

function briefItemRoute(item: CompassRecommendation): string {
  if (item.type === 'event') {
    // event.id is a raw UUID from the hydrator
    return `/event/${item.id}`;
  }
  if (item.type === 'hidden_gem') {
    // data.id is the raw UUID; the prefixed item.id is "gem:<uuid>"
    const rawId = (item.data?.id as string | undefined) ?? item.id.replace(/^gem:/, '');
    return `/gems/${rawId}`;
  }
  if (item.type === 'place') {
    // No standalone place detail route exists — navigate to Discovery tab
    return '/(tabs)/discovery';
  }
  return '/(tabs)/discovery';
}

const CAN_ADD_TO_PLAN = new Set(['event', 'place', 'hidden_gem']);

function BriefItemCard({ item, tripId }: { item: CompassRecommendation; tripId?: string }) {
  const icon = TYPE_ICONS[item.type] ?? '✨';
  const [adding, setAdding] = useState(false);
  const [added, setAdded]   = useState(false);

  async function handleAddToPlan() {
    if (!tripId || added || adding) return;
    setAdding(true);
    try {
      await createPlanItem(tripId, {
        title:      resolveCompassTitle(item),
        category:   item.type === 'event' ? 'activity' : 'activity',
        sourceType: item.type === 'event' ? 'meetup' : item.type === 'place' || item.type === 'hidden_gem' ? 'place' : undefined,
        sourceId:   item.id || undefined,
        locationName: item.city ?? undefined,
        notes:      item.reason ?? undefined,
      });
      setAdded(true);
    } catch {
      Alert.alert('Could not add', 'Try again in a moment.');
    } finally {
      setAdding(false);
    }
  }

  return (
    <View style={cb.itemCard}>
      <View style={cb.itemHead}>
        <Text style={cb.itemIcon}>{icon}</Text>
        <View style={cb.itemTypeChip}>
          <Text style={cb.itemTypeText}>{item.type.replace('_', ' ')}</Text>
        </View>
      </View>
      <Text style={cb.itemTitle} numberOfLines={2}>{resolveCompassTitle(item)}</Text>
      {(() => {
        const subtitle = formatCompassSubtitle(item);
        return subtitle ? <Text style={cb.itemCity} numberOfLines={1}>📍 {subtitle}</Text> : null;
      })()}
      <Text style={cb.itemReason} numberOfLines={2}>{item.reason}</Text>
      <View style={cb.itemBtnRow}>
        <Pressable
          style={[cb.itemBtn, cb.itemBtnView]}
          onPress={() => {
            // Fire-and-forget "viewed" outcome — the recommendation was opened.
            reportCompassViewed(null, item.id);
            router.push(briefItemRoute(item) as any);
          }}
        >
          <Text style={cb.itemBtnText}>View</Text>
        </Pressable>
        {tripId && CAN_ADD_TO_PLAN.has(item.type) && (
          <Pressable
            style={[cb.itemBtn, cb.itemBtnPlan, added && cb.itemBtnAdded]}
            onPress={handleAddToPlan}
            disabled={adding || added}
          >
            {adding ? (
              <ActivityIndicator size="small" color={color.signal} />
            ) : (
              <Text style={[cb.itemBtnText, { color: added ? color.success : color.signal }]}>
                {added ? '✓ Added' : '+ Plan'}
              </Text>
            )}
          </Pressable>
        )}
      </View>
    </View>
  );
}

export function CompassTripBrief({ tripId, city, startDate, endDate }: CompassTripBriefProps) {
  const [expanded, setExpanded]     = useState(true);
  const [items, setItems]           = useState<CompassRecommendation[]>([]);
  const [loading, setLoading]       = useState(false);
  const [fetched, setFetched]       = useState(false);

  useEffect(() => {
    if (!city && !tripId) { setFetched(true); return; }
    setLoading(true);
    fetchCompassTripBrief({ tripId: tripId ?? '', city, startDate, endDate, limit: 6 })
      .then((res) => {
        if (res.ok && res.data) setItems(res.data.recommendations);
      })
      .catch(() => {})
      .finally(() => { setLoading(false); setFetched(true); });
  }, [tripId, city, startDate, endDate]);

  // Hide entirely when loaded with no items (Compass disabled, no results, or no city)
  if (fetched && items.length === 0 && !loading) return null;

  return (
    <View>
      <TravelSectionHeader
        title="Compass Brief"
        onAction={() => setExpanded((v) => !v)}
        actionLabel={expanded ? 'Collapse' : 'Expand'}
      />
      {loading && (
        <View style={cb.loadingRow}>
          <ActivityIndicator size="small" color={color.signal} />
          <Text style={cb.loadingText}>Loading recommendations…</Text>
        </View>
      )}
      {!loading && expanded && items.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={cb.strip}>
          {items.map((item) => <BriefItemCard key={item.id} item={item} tripId={tripId} />)}
        </ScrollView>
      )}
    </View>
  );
}

/* ── Trip Stamps ── */
export function TripStamps({ stamps }: { stamps: PassportStamp[] }) {
  const earned = stamps.filter((s) => !s.locked);
  return (
    <View>
      <TravelSectionHeader title="Trip Stamps" onAction={() => router.push('/stamps')} actionLabel="View all" />
      {stamps.length === 0 ? (
        <TravelEmptyState title="No stamps yet — start exploring!" sub="Earn stamps by joining plans, checking in, and sharing discoveries." />
      ) : (
        <View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={ts.strip}>
            {stamps.map((s, i) => <PassportStampCard key={s.id} stamp={s} rotate={((i % 3) - 1) * 2} onPress={() => router.push('/stamps')} />)}
          </ScrollView>
          <Text style={ts.note}>{earned.length} earned · {stamps.length - earned.length} to unlock</Text>
        </View>
      )}
    </View>
  );
}

/* ── Trip Map (entry point to the full map — no live location here) ── */
/**
 * `tripId` is the map's §11 Trip Map context.
 *
 * The /map shell reads `params.tripId` and gates three things on it — the trip
 * itinerary objects, the Optimize Today chip, and the Locate My Friends group
 * scope. This is the ONE entry point that legitimately knows which trip the
 * user is looking at; every other push to /map (gems, passport stamps, the
 * circle map, and the three Compass place/event links) is about a place or a
 * person and has no trip to name, so none of them gained the parameter.
 *
 * Optional rather than required: without a trip the header still opens the map,
 * it just opens it with no itinerary — which is the honest result, and better
 * than naming a trip that does not exist.
 *
 * The card is a tap target, not a preview. It used to draw three pins at
 * hardcoded percentages under a "Destination" label and a Plans/Saved/Hidden
 * Gems legend — none of which described the trip being viewed. The user's real
 * pins are on /map, one tap away, so the invented ones were dropped rather than
 * dressed up. Mounted by `app/trip/[id].tsx`, which is what makes `tripId`
 * reachable at all.
 */
export function TripMapPreview({ tripId }: { tripId?: string } = {}) {
  const mapHref = tripId
    ? `/map?entityTypes=trips&entry=trip&tripId=${encodeURIComponent(tripId)}`
    : '/map?entityTypes=trips&entry=trip';
  const openMap = () => router.push(mapHref as any);
  return (
    <View>
      <TravelSectionHeader title="Trip Map" onAction={openMap} actionLabel="View map" />
      <Pressable
        style={({ pressed }) => [mp.card, pressed && { opacity: layout.pressedOpacity }]}
        onPress={openMap}
        accessibilityRole="button"
        accessibilityLabel="Open this trip on the map"
      >
        <View style={mp.prompt}>
          <View style={mp.iconWrap}><MapIcon size={22} color={color.deep} /></View>
          <View style={{ flex: 1 }}>
            <Text style={mp.title}>See this trip on the map</Text>
            <Text style={mp.sub}>Your stops, saved places, and hidden gems nearby.</Text>
          </View>
          <ChevronRight size={icon.s16} color={color.mute} />
        </View>
        <View style={mp.noteRow}><Info size={11} color={color.mute} /><Text style={mp.note}>Approximate areas only — exact locations stay private.</Text></View>
      </Pressable>
    </View>
  );
}

/* ── Trip Crew Map section ── */
export { CrewMapSection as TripCrewSection } from './tripCrew/CrewMapSection.tsx';

/* ── Safety / Check-In (compact stub) ── */
export function TripSafety({ tripId }: { tripId?: string }) {
  return (
    <View>
      <TravelSectionHeader title="Safety & Check-In" />
      <View style={sf.card}>
        <View style={sf.head}>
          <View style={sf.icon}><ShieldCheck size={18} color={color.deep} /></View>
          <View style={{ flex: 1 }}>
            <Text style={sf.title}>Trip safety tools</Text>
            <Text style={sf.sub}>Share your location and emergency contacts with your Circle while travelling.</Text>
          </View>
        </View>
        <View style={sf.btns}>
          <Pressable
            style={sf.btn}
            onPress={() => router.push('/safety-history' as any)}
          >
            <Text style={sf.btnText}>Safe Return</Text>
          </Pressable>
          <Pressable
            style={sf.btn}
            onPress={() => router.push('/profile/edit/emergency-contacts' as any)}
          >
            <Text style={sf.btnText}>Emergency Contacts</Text>
          </Pressable>
        </View>
        <View style={sf.noteRow}><Info size={11} color={color.mute} /><Text style={sf.note}>Privacy-first — you control what your Circle sees.</Text></View>
      </View>
    </View>
  );
}

/* ── Trip Posts (compact stub) ── */
export function TripPostsSection({ posts }: { posts: { id: string; city: string; caption: string; mediaUrl?: string }[] }) {
  return (
    <View>
      <TravelSectionHeader title="Trip Posts" onAction={posts.length ? () => router.push('/(tabs)/passport') : undefined} actionLabel="View all" />
      {posts.length === 0 ? (
        <TravelEmptyState title="No trip posts yet" sub="Share your first post from this trip — it'll appear here and on your Passport." action="Add Post" onAction={() => router.push('/create')} />
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={tp.strip}>
          {posts.map((post) => (
            <Pressable key={post.id} style={tp.tile} onPress={() => router.push(`/post/${post.id}`)}>
              <View style={tp.media} />
              <Text style={tp.caption} numberOfLines={2}>{post.caption}</Text>
            </Pressable>
          ))}
          <Pressable style={tp.addTile} onPress={() => router.push('/create' as any)}>
            <ImagePlus size={20} color={color.signal} /><Text style={tp.addText}>Add Post</Text>
          </Pressable>
        </ScrollView>
      )}
    </View>
  );
}

/* ─── Styles ─────────────────────────────────────────────────────────────── */

const ring = StyleSheet.create({
  pct: { ...t.hero, color: color.ink, fontSize: 28, marginTop: -18 },
});

const hero = StyleSheet.create({
  wrap: { padding: space.lg, gap: space.md },
  imageCard: { borderRadius: radius.lg, overflow: 'hidden', backgroundColor: color.ink, ...shadow.card },
  imageBg: { height: 150, backgroundColor: color.deep, alignItems: 'flex-end', padding: space.md },
  stampMark: { alignItems: 'center', gap: 2, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.4)', borderRadius: radius.sm, padding: 6 },
  stampText: { fontFamily: 'Courier', fontSize: 9, color: color.onInk, fontWeight: '700', letterSpacing: 1 },
  identity: { padding: space.lg, gap: 5, backgroundColor: color.ink },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { ...t.hero, color: color.onInk, fontSize: 30 },
  activeChip: { backgroundColor: color.signal, paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.sm },
  activeText: { ...t.small, color: color.onInk, fontWeight: '800', fontSize: 11 },
  dest: { ...t.bodyStrong, color: color.onInk },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2, flexWrap: 'wrap' },
  meta: { ...t.small, color: color.haze },
  openChip: { backgroundColor: color.success, paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: radius.sm },
  openText: { ...t.small, color: color.onInk, fontWeight: '700', fontSize: 10 },
  availChip: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', backgroundColor: 'rgba(255,255,255,0.12)', paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.pill, marginTop: space.sm },
  availText: { ...t.small, color: color.onInk, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  action: { flexGrow: 1, flexBasis: '47%', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingVertical: space.md },
  actionText: { ...t.small, fontWeight: '700', color: color.ink },
  progressCard: { backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.lg, padding: space.lg, alignItems: 'center' },
  progressTitle: { ...t.title, color: color.ink, fontSize: 18, alignSelf: 'flex-start' },
  progressSub: { ...t.small, color: color.mute, fontWeight: '600', marginTop: 4 },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  stepText: { ...t.body, color: color.mute },
  stepDone: { color: color.ink },
});

const section = StyleSheet.create({
  wrap: { marginTop: space.lg },
  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, marginBottom: space.md },
  title: { ...t.title, color: color.ink, fontSize: 20 },
  viewAll: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  viewAllText: { ...t.small, color: color.signal, fontWeight: '700' },
  clearAll: { marginRight: space.md },
  clearAllText: { ...t.small, color: '#DC2626', fontWeight: '600' },
});

const nx = StyleSheet.create({
  card: { flexDirection: 'row', marginHorizontal: space.lg, backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, overflow: 'hidden', ...shadow.card },
  media: { width: 120, backgroundColor: color.deep },
  body: { flex: 1, padding: space.md, gap: 4 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  badge: { backgroundColor: '#EFE7FA', paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: radius.sm },
  badgeText: { ...t.small, color: '#7A4DBF', fontWeight: '800', fontSize: 10 },
  time: { ...t.small, color: color.mute, fontFamily: 'Courier' },
  title: { ...t.heading, color: color.ink, fontSize: 16 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  meta: { ...t.small, color: color.mute },
  hostRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  host: { ...t.small, color: color.mute },
  attRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 2 },
  // Sizing/shape come from <Avatar size>; this is the overlap ring only.
  attAvatarRing: { borderWidth: 2, borderColor: color.paperRaised },
  going: { ...t.small, color: color.mute },
  btns: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  primary: { flex: 1, backgroundColor: color.signal, borderRadius: radius.md, paddingVertical: space.sm, alignItems: 'center' },
  primaryText: { ...t.small, fontWeight: '800', color: color.onInk },
  ghost: { flex: 1, borderWidth: 1.5, borderColor: color.signal, borderRadius: radius.md, paddingVertical: space.sm, alignItems: 'center' },
  ghostText: { ...t.small, fontWeight: '800', color: color.signal },
  empty: { marginHorizontal: space.lg, padding: space.lg, borderRadius: radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: color.haze, gap: space.md, alignItems: 'flex-start' },
  emptyText: { ...t.body, color: color.mute },
  emptyBtn: { backgroundColor: color.signal, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.sm },
  emptyBtnText: { ...t.small, fontWeight: '800', color: color.onInk },
});

const tl = StyleSheet.create({
  dayRow: { gap: space.sm, paddingHorizontal: space.lg, paddingBottom: space.md },
  dayTab: { alignItems: 'center', paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised, minWidth: 56 },
  dayTabOn: { backgroundColor: color.signal, borderColor: color.signal },
  dayLabel: { ...t.small, fontWeight: '800', color: color.ink, fontSize: 11 },
  daySub: { ...t.small, color: color.mute, fontSize: 11 },
  dayLabelOn: { color: color.onInk },
  items: { paddingHorizontal: space.lg, gap: space.md },
  item: { flexDirection: 'row', gap: space.md },
  timeCol: { width: 56, alignItems: 'flex-start' },
  itemTime: { ...t.small, color: color.mute, fontFamily: 'Courier', fontSize: 11 },
  dot: { width: dot.s10, height: dot.s10, borderRadius: dot.s10 / 2, backgroundColor: color.signal, marginTop: 4 },
  dotOpen: { backgroundColor: color.paper, borderWidth: 2, borderColor: color.faint },
  itemCard: { flex: 1, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.md, gap: 2 },
  itemFree: { borderStyle: 'dashed', backgroundColor: color.paper },
  itemTitle: { ...t.bodyStrong, color: color.ink },
  itemPlace: { ...t.small, color: color.mute },
  itemGoing: { ...t.small, color: color.mute, marginTop: 2 },
  empty: { ...t.body, color: color.mute, paddingHorizontal: space.lg },
  viewFull: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 2, marginTop: space.md },
  viewFullText: { ...t.small, color: color.signal, fontWeight: '700' },
});

const si = StyleSheet.create({
  strip: { gap: space.md, paddingHorizontal: space.lg, paddingBottom: space.sm },
  card: { width: 150, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, overflow: 'hidden', ...shadow.card },
  media: { height: 100, backgroundColor: color.deep, alignItems: 'flex-end', padding: space.sm },
  bookmark: { width: icon.s26, height: icon.s26, borderRadius: icon.s26 / 2, backgroundColor: 'rgba(17,17,15,0.4)', alignItems: 'center', justifyContent: 'center' },
  body: { padding: space.md, gap: 4 },
  name: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  hood: { ...t.small, color: color.mute, fontSize: 11 },
  cat: { alignSelf: 'flex-start', paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: radius.sm },
  catText: { ...t.small, fontWeight: '700', fontSize: 11 },
  empty: { marginHorizontal: space.lg, padding: space.lg, borderRadius: radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: color.haze },
  emptyText: { ...t.body, color: color.mute },
});

const pl = StyleSheet.create({
  tabs: { gap: space.sm, paddingHorizontal: space.lg, paddingBottom: space.md },
  tab: { paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  tabOn: { backgroundColor: color.signal, borderColor: color.signal },
  tabText: { ...t.small, fontWeight: '700', color: color.ink, fontSize: 13 },
  tabTextOn: { color: color.onInk },
  list: { gap: space.md, paddingHorizontal: space.lg },
  card: { flexDirection: 'row', backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, overflow: 'hidden', ...shadow.card },
  media: { width: 84, backgroundColor: color.deep },
  body: { flex: 1, padding: space.md, gap: 2 },
  title: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  lineText: { ...t.small, color: color.mute, fontSize: 11 },
  going: { ...t.small, color: color.mute, fontSize: 11, marginTop: 2 },
  actions: { justifyContent: 'center', alignItems: 'center', gap: space.sm, paddingRight: space.md },
  viewBtn: { borderWidth: 1.5, borderColor: color.signal, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: 6 },
  viewText: { ...t.small, fontWeight: '800', color: color.signal, fontSize: 12 },
  msgBtn: { width: avatar.s30, height: avatar.s30, borderRadius: avatar.s30 / 2, borderWidth: 1, borderColor: color.haze, alignItems: 'center', justifyContent: 'center' },
});

const cr = StyleSheet.create({
  card: { marginHorizontal: space.lg, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.lg, gap: space.md, ...shadow.card },
  count: { ...t.bodyStrong, color: color.ink },
  avatars: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  avatarWrap: {},
  onlineDot: { position: 'absolute', right: 0, bottom: 0, width: dot.s12, height: dot.s12, borderRadius: dot.s12 / 2, backgroundColor: color.success, borderWidth: 2, borderColor: color.paperRaised },
  inviteBtn: { width: avatar.s48, height: avatar.s48, borderRadius: avatar.s48 / 2, borderWidth: 1.5, borderStyle: 'dashed', borderColor: color.signal, alignItems: 'center', justifyContent: 'center' },
  inviteRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  inviteText: { ...t.small, fontWeight: '700', color: color.signal },
  divider: { height: 1, backgroundColor: color.haze },
  suggestLabel: { ...t.small, color: color.mute, fontWeight: '600' },
  suggestRow: { gap: space.sm, alignItems: 'center' },
  suggestMore: { width: avatar.s40, height: avatar.s40, borderRadius: avatar.s40 / 2, borderWidth: 1, borderColor: color.haze, alignItems: 'center', justifyContent: 'center' },
});

const cb = StyleSheet.create({
  card:        { marginHorizontal: space.lg, backgroundColor: color.ink, borderRadius: radius.lg, padding: space.lg, gap: space.md, ...shadow.card },
  emptyCard:   { marginHorizontal: space.lg, backgroundColor: color.ink, borderRadius: radius.lg, padding: space.lg, gap: space.md, ...shadow.card },
  head:        { flexDirection: 'row', alignItems: 'center', gap: space.md },
  icon:        { width: avatar.s40, height: avatar.s40, borderRadius: avatar.s40 / 2, backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center' },
  title:       { ...t.bodyStrong, color: color.onInk, fontSize: 16 },
  sub:         { ...t.small, color: color.onInkMute, marginTop: 1 },
  cta:         { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: color.signal, borderRadius: radius.md, paddingVertical: space.md },
  ctaText:     { ...t.bodyStrong, color: color.onInk },
  chips:       { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip:        { backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: space.sm },
  chipText:    { ...t.small, color: color.onInk, fontWeight: '600' as const, fontSize: 12 },
  loadingRow:  { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md },
  loadingText: { ...t.small, color: color.mute, fontSize: 12 },
  strip:       { gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm },
  itemCard:    {
    width: 172,
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    gap: space.xs,
  },
  itemHead:     { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  itemIcon:     { fontSize: 16 },
  itemTypeChip: { backgroundColor: color.signal + '15', borderRadius: radius.pill, paddingHorizontal: 6, paddingVertical: 2 },
  itemTypeText: { ...t.small, color: color.signal, fontSize: 9, fontWeight: '700' as const, textTransform: 'uppercase' as const, letterSpacing: 0.4 },
  itemTitle:    { ...t.bodyStrong, color: color.ink, fontSize: 13, lineHeight: 17 },
  itemCity:     { ...t.small, color: color.faint, fontSize: 10 },
  itemReason:   { ...t.small, color: color.mute, fontSize: 10, fontStyle: 'italic' as const, lineHeight: 13 },
  itemBtnRow:   { marginTop: 2, flexDirection: 'row' as const, gap: 4 },
  itemBtn:      { flex: 1, borderRadius: radius.sm, paddingVertical: 7, alignItems: 'center' as const, justifyContent: 'center' as const },
  itemBtnView:  { backgroundColor: color.ink },
  itemBtnPlan:  { backgroundColor: color.signal + '15', borderWidth: 1, borderColor: color.signal + '40' },
  itemBtnAdded: { backgroundColor: color.success + '12', borderColor: color.success + '30' },
  itemBtnText:  { ...t.small, color: color.onInk, fontWeight: '700' as const, fontSize: 11 },
});

const ts = StyleSheet.create({
  strip: { gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.xs },
  note: { ...t.small, color: color.mute, paddingHorizontal: space.lg, marginTop: space.sm },
});

const mp = StyleSheet.create({
  card: { marginHorizontal: space.lg, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, overflow: 'hidden', ...shadow.card },
  prompt: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md },
  iconWrap: { width: avatar.s40, height: avatar.s40, borderRadius: avatar.s40 / 2, backgroundColor: '#E2EDF0', alignItems: 'center', justifyContent: 'center' },
  title: { ...t.bodyStrong, color: color.ink, fontSize: 15 },
  sub: { ...t.small, color: color.mute, marginTop: 1 },
  noteRow: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.md, paddingBottom: space.md },
  note: { ...t.small, color: color.mute, fontSize: 11 },
});

const sf = StyleSheet.create({
  card: { marginHorizontal: space.lg, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.lg, gap: space.md, ...shadow.card },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  icon: { width: avatar.s40, height: avatar.s40, borderRadius: avatar.s40 / 2, backgroundColor: '#E3F1EA', alignItems: 'center', justifyContent: 'center' },
  title: { ...t.bodyStrong, color: color.ink, fontSize: 15 },
  sub: { ...t.small, color: color.mute, marginTop: 1 },
  btns: { flexDirection: 'row', gap: space.sm },
  btn: { flex: 1, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingVertical: space.sm, alignItems: 'center' },
  btnText: { ...t.small, fontWeight: '700', color: color.ink, fontSize: 12 },
  noteRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  note: { ...t.small, color: color.mute, fontSize: 11 },
});

const tp = StyleSheet.create({
  strip: { gap: space.md, paddingHorizontal: space.lg },
  tile: { width: 140, gap: 6 },
  media: { height: 100, borderRadius: radius.sm, backgroundColor: color.deep },
  caption: { ...t.small, color: color.ink, fontSize: 12 },
  addTile: { width: 140, height: 130, borderRadius: radius.md, borderWidth: 1.5, borderStyle: 'dashed', borderColor: color.signal, alignItems: 'center', justifyContent: 'center', gap: 6 },
  addText: { ...t.small, fontWeight: '700', color: color.signal },
});
