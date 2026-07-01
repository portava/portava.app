import React, { useState } from 'react';
import { View, Text, Image, Pressable, ScrollView, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import Svg, { Path } from 'react-native-svg';
import {
  CalendarDays, User as UserIcon, Clock, MapPin, CheckCircle2, Circle as CircleIcon,
  CalendarPlus, UserPlus, Sparkles, Settings, Bookmark, Plus, ChevronRight, Plane,
  MessageCircle, ShieldCheck, ImagePlus, Info, X,
} from 'lucide-react-native';
import { useTripSavedPlaces } from '../hooks/useTripSavedPlaces';
import type { BookmarkedPlace } from '../services/discoveryBookmarks';
import type { TripDetail, SavedIdea, TimelineDay, PassportStamp, User } from '../types/models';
import type { TripPlan, TripPlanStatus } from '../__fixtures__/tripDetail';
import { color, space, radius, type as t, shadow, layout } from '../theme/tokens';
import { useAttach } from './AttachController';
import { useAttachments } from '../context/AttachmentStore';
import { PassportStampCard } from './PassportStampCard';
import { TravelSectionHeader, TravelEmptyState } from './primitives';
import { HighlightRing } from './HighlightRing';
import { HighlightViewer } from './HighlightViewer';
import { useHighlightRingState } from '../hooks/useHighlightRingState';

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
  const dates = `${fmt(trip.startDate)} – ${fmt(trip.endDate)}, ${new Date(trip.endDate).getFullYear()}`;
  return (
    <View style={hero.wrap}>
      <View style={hero.imageCard}>
        <View style={hero.imageBg}>
          <View style={hero.stampMark}><Plane size={16} color={color.onInk} /><Text style={hero.stampText}>CEBU</Text></View>
        </View>
        <View style={hero.identity}>
          <View style={hero.titleRow}>
            <Text style={hero.title}>{trip.title}</Text>
            <View style={hero.activeChip}><Text style={hero.activeText}>{cap(trip.status)}</Text></View>
          </View>
          <Text style={hero.dest}>{trip.destinationCity}, {trip.destinationCountry}</Text>
          <View style={hero.metaRow}><CalendarDays size={14} color={color.onInk} /><Text style={hero.meta}>{dates} ({trip.nights} nights)</Text></View>
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
        <Action icon={<CalendarPlus size={18} color={color.signal} />} label="Add Plan" onPress={() => router.push('/create')} />
        <Action icon={<UserPlus size={18} color={color.ink} />} label="Invite Buddy" onPress={() => router.push('/circle')} />
        <Action icon={<Sparkles size={18} color={color.signal} />} label="Ask Compass" onPress={() => router.push('/(tabs)/ai')} />
        <Action icon={<Settings size={18} color={color.ink} />} label="Trip Settings" onPress={() => router.push('/settings')} />
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
export function TodayNextUp({ nextUp }: { nextUp: any | null }) {
  return (
    <View style={section.wrap}>
      <SectionHead title="Today / Next Up" onViewAll={nextUp ? () => router.push('/(tabs)/trips') : undefined} />
      {!nextUp ? (
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
              <Image source={{ uri: nextUp.host.avatarUrl }} style={nx.hostAvatar} />
              <Text style={nx.host}>Hosted by {nextUp.host.name.split(' ')[0]}</Text>
            </View>
            <View style={nx.attRow}>
              <AvatarRow people={nextUp.attendees} />
              <Text style={nx.going}>{nextUp.attendeeCount} going</Text>
            </View>
            <View style={nx.btns}>
              <Pressable style={nx.primary} onPress={() => router.push('/(tabs)/trips')}><Text style={nx.primaryText}>View Plan</Text></Pressable>
              <Pressable style={nx.ghost} onPress={() => router.push('/messages')}><Text style={nx.ghostText}>Message Group</Text></Pressable>
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
        <Image key={u.id} source={{ uri: u.avatarUrl }} style={[nx.attAvatar, { marginLeft: i === 0 ? 0 : -9, zIndex: 4 - i }]} />
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
export function SavedIdeas({ ideas, tripId }: { ideas: SavedIdea[]; tripId: string }) {
  const attach = useAttach();
  const { listAttachmentsByTarget } = useAttachments();
  const CAT_TONE: Record<string, { bg: string; fg: string }> = {
    Food: { bg: '#FCE9E4', fg: color.signal },
    Nightlife: { bg: '#EFE7FA', fg: '#7A4DBF' },
    Nature: { bg: '#E3F1EA', fg: color.success },
    Beach: { bg: '#E2EDF0', fg: color.deep },
  };
  const added = listAttachmentsByTarget(tripId);
  const hasAny = ideas.length > 0 || added.length > 0;
  return (
    <View style={section.wrap}>
      <SectionHead title="Saved Ideas" onViewAll={hasAny ? () => router.push('/saved') : undefined} />
      {!hasAny ? (
        <View style={si.empty}><Text style={si.emptyText}>Save places from the Discovery Wall to build this trip.</Text></View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={si.strip}>
          {added.map((att) => (
            <View key={att.id} style={si.card}>
              <View style={si.media}>
                <View style={si.bookmark}><Bookmark size={15} color={color.onInk} fill={color.onInk} /></View>
              </View>
              <View style={si.body}>
                <Text style={si.name} numberOfLines={1}>{att.sourceTitle}</Text>
                <Text style={si.hood} numberOfLines={1}>{att.sourceCity ?? 'Added this session'}</Text>
                <View style={[si.cat, { backgroundColor: '#E3F1EA' }]}><Text style={[si.catText, { color: color.success }]}>Added</Text></View>
              </View>
            </View>
          ))}
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
                  <Pressable style={si.addBtn} onPress={() => attach.open({ id: idea.id, type: 'place', title: idea.name, city: idea.neighborhood, category: idea.category }, 'plan')}><Text style={si.addText}>Add to Plan</Text></Pressable>
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
    width: 24,
    height: 24,
    borderRadius: 12,
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
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
export function TripPlans({ plans }: { plans: TripPlan[] }) {
  const [tab, setTab] = useState<TripPlanStatus>('joined');
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
        <TravelEmptyState title="No trip plans yet" sub="Add one from Pulse or create your own." action="Browse Pulse" onAction={() => router.push('/' as any)} />
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
                  <Pressable style={pl.msgBtn} onPress={() => router.push('/messages')} hitSlop={layout.hitSlop}><MessageCircle size={15} color={color.mute} /></Pressable>
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

  const img = <Image source={{ uri: u.avatarUrl }} style={cr.avatar} />;

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
export function TripCircle({ cityCount, inCity, suggested, currentUserId }: { cityCount: number; inCity: User[]; suggested: User[]; currentUserId?: string | null }) {
  return (
    <View>
      <TravelSectionHeader title="Trip Circle" onAction={() => router.push('/circle')} actionLabel="View all" />
      <View style={cr.card}>
        <Text style={cr.count}>{cityCount} buddies are in Cebu</Text>
        <View style={cr.avatars}>
          {inCity.map((u) => (
            <MemberAvatar key={u.id} u={u} currentUserId={currentUserId} />
          ))}
          <Pressable style={cr.inviteBtn} onPress={() => router.push('/circle')}>
            <UserPlus size={16} color={color.signal} />
          </Pressable>
        </View>
        <Pressable style={cr.inviteRow} onPress={() => router.push('/circle')}>
          <Plus size={14} color={color.signal} /><Text style={cr.inviteText}>Invite more buddies</Text>
        </Pressable>
        <View style={cr.divider} />
        <Text style={cr.suggestLabel}>People you may want to connect with</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={cr.suggestRow}>
          {suggested.map((u) => (
            <Pressable key={u.id} onPress={() => router.push(`/profile/${u.handle}`)}>
              <Image source={{ uri: u.avatarUrl }} style={cr.suggestAvatar} />
            </Pressable>
          ))}
          <Pressable style={cr.suggestMore} onPress={() => router.push('/circle')}><ChevronRight size={18} color={color.mute} /></Pressable>
        </ScrollView>
      </View>
    </View>
  );
}

/* ── Compass Trip Brief ── */
export function CompassTripBrief() {
  const prompts = ['Build tonight from saved ideas', 'Find plans that fit my availability', 'Summarize this trip', 'Suggest what to do next'];
  return (
    <View>
      <TravelSectionHeader title="Compass Trip Brief" />
      <View style={cb.card}>
        <View style={cb.head}>
          <View style={cb.icon}><Sparkles size={18} color={color.onInk} /></View>
          <View style={{ flex: 1 }}>
            <Text style={cb.title}>Let Compass build your perfect night</Text>
            <Text style={cb.sub}>Based on your trip city, dates, saved ideas, and availability.</Text>
          </View>
        </View>
        <Pressable style={cb.cta} onPress={() => router.push('/(tabs)/ai')}>
          <Sparkles size={16} color={color.onInk} /><Text style={cb.ctaText}>Ask Compass</Text>
        </Pressable>
        <View style={cb.chips}>
          {prompts.map((pr) => (
            <Pressable key={pr} style={cb.chip} onPress={() => router.push('/(tabs)/ai')}>
              <Text style={cb.chipText}>{pr}</Text>
            </Pressable>
          ))}
        </View>
      </View>
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
        <TravelEmptyState title="No trip stamps yet" sub="Earn stamps by joining plans, checking in, and sharing discoveries." />
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

/* ── Map Preview (compact stub — approximate only, no live location) ── */
export function TripMapPreview() {
  return (
    <View>
      <TravelSectionHeader title="Map Preview" onAction={() => router.push('/(tabs)/discovery')} actionLabel="View map" />
      <View style={mp.card}>
        <View style={mp.map}>
          <View style={[mp.pin, { top: '30%', left: '25%', backgroundColor: color.signal }]} />
          <View style={[mp.pin, { top: '55%', left: '60%', backgroundColor: color.deep }]} />
          <View style={[mp.pin, { top: '40%', left: '75%', backgroundColor: color.success }]} />
          <View style={mp.cityLabel}><Text style={mp.cityText}>Cebu City</Text></View>
        </View>
        <View style={mp.legend}>
          <View style={mp.legendItem}><View style={[mp.dot, { backgroundColor: color.signal }]} /><Text style={mp.legendText}>Plans</Text></View>
          <View style={mp.legendItem}><View style={[mp.dot, { backgroundColor: color.deep }]} /><Text style={mp.legendText}>Saved</Text></View>
          <View style={mp.legendItem}><View style={[mp.dot, { backgroundColor: color.success }]} /><Text style={mp.legendText}>Hidden Gems</Text></View>
        </View>
        <View style={mp.noteRow}><Info size={11} color={color.mute} /><Text style={mp.note}>Approximate areas only — exact locations stay private.</Text></View>
      </View>
    </View>
  );
}

/* ── Trip Crew Map section ── */
export { CrewMapSection as TripCrewSection } from './tripCrew/CrewMapSection';

/* ── Safety / Check-In (compact stub) ── */
export function TripSafety() {
  return (
    <View>
      <TravelSectionHeader title="Safety & Check-In" />
      <View style={sf.card}>
        <View style={sf.head}>
          <View style={sf.icon}><ShieldCheck size={18} color={color.success} /></View>
          <View style={{ flex: 1 }}>
            <Text style={sf.title}>All good!</Text>
            <Text style={sf.sub}>You're checked in and sharing your trip with your Circle.</Text>
          </View>
        </View>
        <View style={sf.btns}>
          <Pressable style={sf.btn} onPress={() => Alert.alert('Coming Soon', 'Safe Return check-ins are coming in a future update.', [{ text: 'OK' }])}><Text style={sf.btnText}>Start Safe Return</Text></Pressable>
          <Pressable style={sf.btn} onPress={() => Alert.alert('Coming Soon', 'Emergency Contacts management is coming in a future update.', [{ text: 'OK' }])}><Text style={sf.btnText}>Emergency Contacts</Text></Pressable>
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
        <TravelEmptyState title="No trip posts yet" sub="Share a moment from this trip — it'll appear here and on your Passport." action="Add Post" onAction={() => router.push('/create')} />
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
  hostAvatar: { width: 20, height: 20, borderRadius: 10, backgroundColor: color.haze },
  host: { ...t.small, color: color.mute },
  attRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 2 },
  attAvatar: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: color.paperRaised, backgroundColor: color.haze },
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
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: color.signal, marginTop: 4 },
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
  bookmark: { width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(17,17,15,0.4)', alignItems: 'center', justifyContent: 'center' },
  body: { padding: space.md, gap: 4 },
  name: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  hood: { ...t.small, color: color.mute, fontSize: 11 },
  cat: { alignSelf: 'flex-start', paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: radius.sm },
  catText: { ...t.small, fontWeight: '700', fontSize: 11 },
  addBtn: { borderWidth: 1.5, borderColor: color.signal, borderRadius: radius.sm, paddingVertical: 6, alignItems: 'center', marginTop: 2 },
  addText: { ...t.small, fontWeight: '800', color: color.signal, fontSize: 12 },
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
  msgBtn: { width: 30, height: 30, borderRadius: 15, borderWidth: 1, borderColor: color.haze, alignItems: 'center', justifyContent: 'center' },
});

const cr = StyleSheet.create({
  card: { marginHorizontal: space.lg, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.lg, gap: space.md, ...shadow.card },
  count: { ...t.bodyStrong, color: color.ink },
  avatars: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  avatarWrap: {},
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: color.haze },
  onlineDot: { position: 'absolute', right: 0, bottom: 0, width: 12, height: 12, borderRadius: 6, backgroundColor: color.success, borderWidth: 2, borderColor: color.paperRaised },
  inviteBtn: { width: 48, height: 48, borderRadius: 24, borderWidth: 1.5, borderStyle: 'dashed', borderColor: color.signal, alignItems: 'center', justifyContent: 'center' },
  inviteRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  inviteText: { ...t.small, fontWeight: '700', color: color.signal },
  divider: { height: 1, backgroundColor: color.haze },
  suggestLabel: { ...t.small, color: color.mute, fontWeight: '600' },
  suggestRow: { gap: space.sm, alignItems: 'center' },
  suggestAvatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: color.haze },
  suggestMore: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, borderColor: color.haze, alignItems: 'center', justifyContent: 'center' },
});

const cb = StyleSheet.create({
  card: { marginHorizontal: space.lg, backgroundColor: color.ink, borderRadius: radius.lg, padding: space.lg, gap: space.md, ...shadow.card },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  icon: { width: 40, height: 40, borderRadius: 20, backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center' },
  title: { ...t.bodyStrong, color: color.onInk, fontSize: 16 },
  sub: { ...t.small, color: color.onInkMute, marginTop: 1 },
  cta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: color.signal, borderRadius: radius.md, paddingVertical: space.md },
  ctaText: { ...t.bodyStrong, color: color.onInk },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: { backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: space.sm },
  chipText: { ...t.small, color: color.onInk, fontWeight: '600', fontSize: 12 },
});

const ts = StyleSheet.create({
  strip: { gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.xs },
  note: { ...t.small, color: color.mute, paddingHorizontal: space.lg, marginTop: space.sm },
});

const mp = StyleSheet.create({
  card: { marginHorizontal: space.lg, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, overflow: 'hidden', ...shadow.card },
  map: { height: 150, backgroundColor: '#DDE6E8' },
  pin: { position: 'absolute', width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: color.paper },
  cityLabel: { position: 'absolute', top: '44%', left: '38%', backgroundColor: 'rgba(255,255,255,0.7)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  cityText: { ...t.small, color: color.ink, fontWeight: '700', fontSize: 11 },
  legend: { flexDirection: 'row', gap: space.lg, padding: space.md },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  legendText: { ...t.small, color: color.mute, fontSize: 12 },
  noteRow: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.md, paddingBottom: space.md },
  note: { ...t.small, color: color.mute, fontSize: 11 },
});

const sf = StyleSheet.create({
  card: { marginHorizontal: space.lg, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.lg, gap: space.md, ...shadow.card },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  icon: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#E3F1EA', alignItems: 'center', justifyContent: 'center' },
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
