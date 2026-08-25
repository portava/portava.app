/**
 * LivingDestinationPage — full-screen living destination experience.
 *
 * Renders the canonical path for /place/[id] when the living endpoint
 * returns data. Sparse places (< 5 posts) render in sparse mode:
 * hero + info strip + directions + official info + AI summary only.
 *
 * Sub-components defined inline:
 *   PlaceHeroCarousel, PlaceInfoStrip, PlaceDirectionsRow,
 *   PlaceOfficialInfoCard, PlaceAiSummaryCard, PlaceBucketTabs,
 *   PlacePostGrid, DedupGroupCard, PlaceBeFirstCard,
 *   PlaceTimelinePicker, PlaceLiveStatusBar, PlaceBestOfShelf,
 *   PlaceTopContributorChip
 */
import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  Dimensions,
  FlatList,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  ActivityIndicator,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ChevronDown,
  ChevronUp,
  Clock,
  Cloud,
  Globe,
  MapPin,
  Navigation,
  Phone,
  PlayCircle,
  Star,
  ThumbsUp,
  Users,
  Wind,
  Sparkles,
  Camera,
  Image as ImageIcon,
  Award,
  CalendarDays,
  Radio,
} from 'lucide-react-native';
import { router } from 'expo-router';
import { CachedImage } from '../../CachedImage.tsx';
import { color, space, radius, type as t, shadow, typography, icon, aspect, dot} from '../../../theme/tokens.ts';
import { getPlaceTimeline } from '../../../services/places.ts';
import { useIntelPrompts } from '../../../hooks/useIntelPrompts.ts';
import { DecisionExposureChips, buildLiveClaims } from '../../intel/DecisionExposureChips.tsx';
import type {
  PlaceLivingResponse,
  LivingBucket,
  LivingBucketPost,
  LivingTimelinePost,
  LivingBestOfItem,
  LivingDedupGroup,
  TimelineSlice,
} from '../../../types/placeLiving.ts';
import type { CanonicalPlace } from '../../../types/canonicalPlace.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

const SCREEN_WIDTH = Dimensions.get('window').width;
const HERO_HEIGHT = 280;
const COMPACT_HEADER_HEIGHT = 56;
const HERO_COLLAPSE_DISTANCE = HERO_HEIGHT - COMPACT_HEADER_HEIGHT;

const PREFERRED_MAPS_APP_KEY = 'preferredMapsApp';
type MapsApp = 'apple_maps' | 'google_maps' | 'waze';

const BUCKET_LABELS: Record<string, string> = {
  night:          'Night',
  drone:          'Drone',
  underwater:     'Underwater',
  adventure:      'Adventure',
  hidden_angles:  'Hidden Angles',
  tips:           'Tips',
};

const CROWD_COLORS: Record<string, string> = {
  low:    '#047857',
  medium: '#C8851A',
  high:   '#B91C1C',
};

// ── PlaceHeroCarousel ─────────────────────────────────────────────────────────

interface HeroItem {
  key: string;
  type: 'image' | 'video';
  url: string;
}

interface PlaceHeroCarouselProps {
  living: PlaceLivingResponse;
  place: CanonicalPlace;
}

function PlaceHeroCarousel({ living, place }: PlaceHeroCarouselProps) {
  const [activeIndex, setActiveIndex] = useState(0);

  const items: HeroItem[] = [];
  if (living.hero.videoUrl) {
    items.push({ key: 'video', type: 'video', url: living.hero.videoUrl });
  }
  const photoUrls = (living.bestOf?.photos ?? []).slice(0, 5).map((p) => p.mediaUrl).filter(Boolean) as string[];
  if (photoUrls.length === 0 && living.hero.imageUrl) {
    photoUrls.push(living.hero.imageUrl);
  }
  photoUrls.forEach((url, i) => {
    items.push({ key: `photo-${i}`, type: 'image', url });
  });

  const fallbackItem: HeroItem = {
    key: 'fallback',
    type: 'image',
    url: '',
  };
  const displayItems = items.length > 0 ? items : [fallbackItem];

  return (
    <View style={hero.wrap}>
      <FlatList
        data={displayItems}
        keyExtractor={(item) => item.key}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(e) => {
          const index = Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH);
          setActiveIndex(index);
        }}
        renderItem={({ item }) => (
          <View style={hero.slide}>
            {item.url ? (
              <CachedImage
                source={{ uri: item.url }}
                style={hero.image}
                resizeMode="cover"
              />
            ) : (
              <View style={[hero.image, hero.imageFallback]}>
                <ImageIcon size={40} color="rgba(250,249,246,0.4)" />
              </View>
            )}
            {item.type === 'video' && (
              <View style={hero.playBadge}>
                <PlayCircle size={20} color="#fff" />
                <Text style={hero.playText}>Video</Text>
              </View>
            )}
          </View>
        )}
      />

      {/* Bottom gradient + name overlay */}
      <LinearGradient
        colors={['transparent', 'rgba(17,17,15,0.82)']}
        style={hero.gradient}
        pointerEvents="none"
      />
      <View style={hero.nameOverlay} pointerEvents="none">
        <Text style={hero.placeName} numberOfLines={2}>{place.name}</Text>
        {place.category ? (
          <Text style={hero.placeCategory}>{capitalize(place.category)}</Text>
        ) : null}
      </View>

      {/* Pager dots */}
      {displayItems.length > 1 && (
        <View style={hero.dotsRow} pointerEvents="none">
          {displayItems.map((item, i) => (
            <View
              key={item.key}
              style={[hero.dot, i === activeIndex && hero.dotActive]}
            />
          ))}
        </View>
      )}
    </View>
  );
}

const hero = StyleSheet.create({
  wrap: {
    width: SCREEN_WIDTH,
    height: HERO_HEIGHT,
    overflow: 'hidden',
    backgroundColor: color.ink,
  },
  slide: {
    width: SCREEN_WIDTH,
    height: HERO_HEIGHT,
  },
  image: {
    width: SCREEN_WIDTH,
    height: HERO_HEIGHT,
  },
  imageFallback: {
    backgroundColor: '#1a1a18',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playBadge: {
    position: 'absolute',
    top: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(17,17,15,0.7)',
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  playText: {
    ...t.stamp,
    color: '#fff',
    fontSize: 10,
  },
  gradient: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 120,
  },
  nameOverlay: {
    position: 'absolute',
    bottom: 36,
    left: 16,
    right: 16,
  },
  placeName: {
    ...t.title,
    color: color.onInk,
  },
  placeCategory: {
    ...t.stamp,
    color: color.onInkMute,
    marginTop: 2,
    textTransform: 'uppercase',
  },
  dotsRow: {
    position: 'absolute',
    bottom: 12,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 5,
  },
  dot: {
    width: dot.s6,
    height: dot.s6,
    borderRadius: dot.s6 / 2,
    backgroundColor: 'rgba(250,249,246,0.4)',
  },
  dotActive: {
    backgroundColor: color.onInk,
    width: 14,
  },
});

// ── PlaceInfoStrip ────────────────────────────────────────────────────────────

interface PlaceInfoStripProps {
  living: PlaceLivingResponse;
  placeName?: string;
  category?: string | null;
}

/** Map a place category to an Intelligence Gathering venue prompt set, if any. */
function categoryToVenue(category?: string | null): 'nightlife' | 'restaurant' | 'event' | 'transit' | 'hotel' | undefined {
  const c = (category ?? '').toLowerCase();
  if (/(night ?club|club|bar|pub|lounge|nightlife)/.test(c)) return 'nightlife';
  if (/(restaurant|cafe|coffee|food|eatery|dining|bistro)/.test(c)) return 'restaurant';
  if (/(event|festival|concert|venue|theatre|theater|stadium|arena)/.test(c)) return 'event';
  if (/(transit|station|airport|bus|train|metro|ferry|terminal)/.test(c)) return 'transit';
  if (/(hotel|hostel|lodging|resort|inn|motel)/.test(c)) return 'hotel';
  return undefined;
}

function PlaceInfoStrip({ living, placeName, category }: PlaceInfoStripProps) {
  const { captureEnabled, liveLabelEnabled, safeReturnActive } = useIntelPrompts();
  // The rich decision-exposure chips own the crowd display when live labels are
  // on and there is a live crowd claim — so we hide the plain crowd chip then to
  // avoid showing crowd twice.
  const richLiveClaims = liveLabelEnabled ? buildLiveClaims(living) : [];
  const richHasCrowd = richLiveClaims.some((c) => c.claimType === 'crowd.level');

  const chips: React.ReactNode[] = [];

  // Rating chip
  if (living.rating?.voteCount && living.rating.voteCount > 0) {
    chips.push(
      <View key="rating" style={strip.chip}>
        <Star size={13} color="#F59E0B" fill="#F59E0B" />
        <Text style={strip.chipText}>
          {living.rating.score != null ? living.rating.score.toFixed(1) : '—'}
          <Text style={strip.chipSub}> ({living.rating.voteCount})</Text>
        </Text>
      </View>,
    );
  }

  // Best-time badge
  if (living.bestTime) {
    chips.push(
      <View key="besttime" style={[strip.chip, strip.chipBestTime]}>
        <Clock size={13} color={color.deep} />
        <Text style={[strip.chipText, { color: color.deep }]}>
          Best: {living.bestTime}
        </Text>
      </View>,
    );
  }

  // Crowd chip — suppressed when the rich Live-intel chips render crowd below.
  if (living.crowdLevel && !(liveLabelEnabled && richHasCrowd)) {
    const crowdColor = CROWD_COLORS[living.crowdLevel.toLowerCase()] ?? color.mute;
    chips.push(
      <View key="crowd" style={[strip.chip, { borderColor: crowdColor + '44' }]}>
        <Users size={13} color={crowdColor} />
        <Text style={[strip.chipText, { color: crowdColor }]}>
          {capitalize(living.crowdLevel)} crowd
        </Text>
      </View>,
    );
  }

  // Weather chip
  const weatherBrief = living.weather?.briefSummary ?? null;
  if (weatherBrief) {
    chips.push(
      <View key="weather" style={strip.chip}>
        <Cloud size={13} color={color.mute} />
        <Text style={strip.chipText} numberOfLines={1}>{weatherBrief}</Text>
      </View>,
    );
  }

  const showShare = captureEnabled && !safeReturnActive;
  const venue = categoryToVenue(category);

  if (chips.length === 0 && richLiveClaims.length === 0 && !showShare) return null;

  return (
    <>
      {chips.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={strip.row}
          style={strip.scroll}
        >
          {chips}
        </ScrollView>
      ) : null}

      {/* Live intelligence decision-exposure chips (intel_live_label_crowd). */}
      <DecisionExposureChips living={living} enabled={liveLabelEnabled} />

      {/* Share a Quick Signal (intel_capture_quick_signal). */}
      {showShare ? (
        <View style={strip.shareWrap}>
          <Pressable
            testID="intel-share-signal"
            accessibilityRole="button"
            accessibilityLabel="Share a live signal about this place"
            onPress={() =>
              router.push({
                pathname: '/intel/quick-signal' as any,
                params: {
                  subjectId: living.placeId,
                  subjectName: placeName ?? '',
                  ...(venue ? { venue } : {}),
                },
              })
            }
            style={({ pressed }) => [strip.shareBtn, pressed && { opacity: 0.85 }]}
          >
            <Radio size={14} color={color.signal} />
            <Text style={strip.shareText}>Share a signal</Text>
            <Text style={strip.shareHint}>· 5 seconds, private</Text>
          </Pressable>
        </View>
      ) : null}
    </>
  );
}

const strip = StyleSheet.create({
  scroll: {
    backgroundColor: color.paperRaised,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    gap: space.sm,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: color.paper,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  chipBestTime: {
    backgroundColor: '#E0F2FE',
    borderColor: '#BAE6FD',
  },
  chipText: {
    ...typography.label,
    color: color.ink,
  },
  chipSub: {
    ...typography.caption,
    color: color.mute,
  },
  shareWrap: {
    backgroundColor: color.paperRaised,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  shareBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    backgroundColor: color.signal + '12',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.signal + '40',
    paddingHorizontal: space.md,
    paddingVertical: 7,
  },
  shareText: { ...typography.button, color: color.signalDim },
  shareHint: { ...typography.metadata, color: color.mute },
});

// ── PlaceDirectionsRow ────────────────────────────────────────────────────────

interface PlaceDirectionsRowProps {
  directionsUrl: PlaceLivingResponse['directionsUrl'];
}

function PlaceDirectionsRow({ directionsUrl }: PlaceDirectionsRowProps) {
  const [mapsSheet, setMapsSheet] = useState(false);
  const [prefLoaded, setPrefLoaded] = useState(false);
  const [pref, setPref] = useState<MapsApp | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(PREFERRED_MAPS_APP_KEY)
      .then((v) => {
        if (v === 'apple_maps' || v === 'google_maps' || v === 'waze') {
          setPref(v);
        }
      })
      .catch(() => {})
      .finally(() => setPrefLoaded(true));
  }, []);

  const openWithApp = useCallback((app: MapsApp) => {
    if (!directionsUrl) return;
    AsyncStorage.setItem(PREFERRED_MAPS_APP_KEY, app).catch(() => {});
    setPref(app);
    setMapsSheet(false);
    const url =
      app === 'apple_maps'  ? directionsUrl.appleMaps :
      app === 'google_maps' ? directionsUrl.googleMaps :
                              directionsUrl.waze;
    Linking.openURL(url).catch(() => {});
  }, [directionsUrl]);

  const handlePress = useCallback(() => {
    if (!directionsUrl) return;
    if (!prefLoaded || !pref) {
      setMapsSheet(true);
      return;
    }
    openWithApp(pref);
  }, [directionsUrl, prefLoaded, pref, openWithApp]);

  return (
    <View style={dr.wrap}>
      <Pressable
        style={({ pressed }) => [dr.btn, pressed && { opacity: 0.8 }]}
        onPress={handlePress}
      >
        <Navigation size={18} color={color.onInk} />
        <Text style={dr.btnText}>Get Directions</Text>
      </Pressable>

      {/* Map app picker sheet */}
      <Modal
        visible={mapsSheet}
        transparent
        animationType="slide"
        onRequestClose={() => setMapsSheet(false)}
      >
        <Pressable style={dr.backdrop} onPress={() => setMapsSheet(false)} />
        <View style={dr.sheet}>
          <View style={dr.handle} />
          <Text style={dr.sheetTitle}>Open in Maps</Text>

          {Platform.OS === 'ios' && (
            <Pressable style={dr.appRow} onPress={() => openWithApp('apple_maps')}>
              <MapPin size={20} color={color.deep} />
              <Text style={dr.appName}>Apple Maps</Text>
            </Pressable>
          )}
          <Pressable style={dr.appRow} onPress={() => openWithApp('google_maps')}>
            <Navigation size={20} color={color.deep} />
            <Text style={dr.appName}>Google Maps</Text>
          </Pressable>
          <Pressable style={dr.appRow} onPress={() => openWithApp('waze')}>
            <Wind size={20} color={color.deep} />
            <Text style={dr.appName}>Waze</Text>
          </Pressable>
        </View>
      </Modal>
    </View>
  );
}

const dr = StyleSheet.create({
  wrap: {
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    backgroundColor: color.paperRaised,
  },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    backgroundColor: color.deep,
    borderRadius: radius.md,
    paddingVertical: 12,
  },
  btnText: {
    ...typography.button,
    color: color.onInk,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingBottom: 40,
    ...shadow.float,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.haze,
    alignSelf: 'center',
    marginTop: space.md,
    marginBottom: space.sm,
  },
  sheetTitle: {
    ...t.heading,
    color: color.ink,
    textAlign: 'center',
    marginBottom: space.lg,
  },
  appRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.xl,
    paddingVertical: 14,
  },
  appName: {
    ...typography.body,
    color: color.ink,
    fontWeight: '500',
  },
});

// ── PlaceOfficialInfoCard ─────────────────────────────────────────────────────

interface PlaceOfficialInfoCardProps {
  info: PlaceLivingResponse['officialInfo'];
}

function PlaceOfficialInfoCard({ info }: PlaceOfficialInfoCardProps) {
  const [expanded, setExpanded] = useState(false);

  const hasContent =
    info.address || info.phone || info.website || info.hours != null || info.priceLevel != null;
  if (!hasContent) return null;

  const priceTier = info.priceLevel != null ? '$'.repeat(Math.min(Math.max(info.priceLevel, 1), 4)) : null;

  return (
    <View style={oc.card}>
      <Pressable style={oc.header} onPress={() => setExpanded((e) => !e)}>
        <Text style={oc.title}>Official Info</Text>
        <View style={oc.openBadgeRow}>
          {info.isOpenNow != null && (
            <View style={[oc.openBadge, info.isOpenNow ? oc.openBadgeOpen : oc.openBadgeClosed]}>
              <Text style={[oc.openBadgeText, info.isOpenNow ? oc.openTextOpen : oc.openTextClosed]}>
                {info.isOpenNow ? 'Open' : 'Closed'}
              </Text>
            </View>
          )}
          {expanded ? <ChevronUp size={16} color={color.mute} /> : <ChevronDown size={16} color={color.mute} />}
        </View>
      </Pressable>

      {expanded && (
        <View style={oc.body}>
          {info.address ? (
            <View style={oc.row}>
              <MapPin size={14} color={color.mute} />
              <Text style={oc.rowText}>{info.address}</Text>
            </View>
          ) : null}
          {priceTier ? (
            <View style={oc.row}>
              <Text style={oc.priceLabel}>{priceTier}</Text>
              <Text style={oc.rowText}>Price level</Text>
            </View>
          ) : null}
          {info.phone ? (
            <Pressable
              style={oc.row}
              onPress={() => Linking.openURL(`tel:${info.phone}`).catch(() => {})}
            >
              <Phone size={14} color={color.deep} />
              <Text style={[oc.rowText, oc.link]}>{info.phone}</Text>
            </Pressable>
          ) : null}
          {info.website ? (
            <Pressable
              style={oc.row}
              onPress={() => info.website && Linking.openURL(info.website).catch(() => {})}
            >
              <Globe size={14} color={color.deep} />
              <Text style={[oc.rowText, oc.link]} numberOfLines={1}>Website</Text>
            </Pressable>
          ) : null}
          {typeof info.hours === 'string' && info.hours ? (
            <View style={oc.row}>
              <Clock size={14} color={color.mute} />
              <Text style={oc.rowText}>{String(info.hours)}</Text>
            </View>
          ) : null}
        </View>
      )}
    </View>
  );
}

const oc = StyleSheet.create({
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    marginHorizontal: space.lg,
    marginTop: space.md,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: color.haze,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
    paddingVertical: 12,
  },
  title: {
    ...typography.cardTitle,
    color: color.ink,
  },
  openBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  openBadge: {
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  openBadgeOpen:   { backgroundColor: '#ECFDF5' },
  openBadgeClosed: { backgroundColor: '#FEF2F2' },
  openBadgeText:   { ...typography.metadata },
  openTextOpen:    { color: '#047857' },
  openTextClosed:  { color: '#B91C1C' },
  body: {
    paddingHorizontal: space.md,
    paddingBottom: space.md,
    gap: space.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  rowText: {
    ...typography.body,
    color: color.ink,
    flex: 1,
    fontSize: 14,
  },
  link: {
    color: color.deep,
    textDecorationLine: 'underline',
  },
  priceLabel: {
    ...typography.label,
    color: color.warn,
    fontWeight: '700',
  },
});

// ── PlaceAiSummaryCard ────────────────────────────────────────────────────────

interface PlaceAiSummaryCardProps {
  summary: string;
}

function PlaceAiSummaryCard({ summary }: PlaceAiSummaryCardProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <View style={ai.card}>
      <View style={ai.header}>
        <Sparkles size={15} color={color.signal} />
        <Text style={ai.title}>AI Summary</Text>
      </View>
      <Text
        style={ai.body}
        numberOfLines={expanded ? undefined : 4}
      >
        {summary}
      </Text>
      <Pressable onPress={() => setExpanded((e) => !e)} style={ai.toggleBtn}>
        <Text style={ai.toggleText}>{expanded ? 'Show less' : 'Read more'}</Text>
        {expanded ? <ChevronUp size={13} color={color.deep} /> : <ChevronDown size={13} color={color.deep} />}
      </Pressable>
      <Text style={ai.disclaimer}>
        AI-generated · based on Portava community + official data
      </Text>
    </View>
  );
}

const ai = StyleSheet.create({
  card: {
    backgroundColor: '#F0F9FF',
    borderRadius: radius.md,
    marginHorizontal: space.lg,
    marginTop: space.md,
    padding: space.md,
    borderWidth: 1,
    borderColor: '#BAE6FD',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: space.sm,
  },
  title: {
    ...typography.cardTitle,
    color: color.ink,
  },
  body: {
    ...typography.body,
    color: color.ink,
    lineHeight: 22,
    fontSize: 14,
  },
  toggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: space.sm,
  },
  toggleText: {
    ...typography.label,
    color: color.deep,
  },
  disclaimer: {
    ...typography.caption,
    color: color.mute,
    marginTop: space.sm,
    fontStyle: 'italic',
    fontSize: 11,
  },
});

// ── PlacePostGrid ─────────────────────────────────────────────────────────────

type GridPost = LivingBucketPost | LivingTimelinePost;

interface PlacePostGridProps {
  posts: GridPost[];
  dedupGroups?: LivingDedupGroup[];
  onPostPress?: (post: GridPost) => void;
}

function PostThumb({ post, onPress }: { post: GridPost; onPress?: () => void }) {
  const [imgFailed, setImgFailed] = useState(false);
  const url = post.thumbnailUrl ?? post.mediaUrl ?? null;

  return (
    <Pressable
      style={({ pressed }) => [pg.thumb, pressed && { opacity: 0.85 }]}
      onPress={onPress}
    >
      {url && !imgFailed ? (
        <CachedImage
          source={{ uri: url }}
          style={pg.thumbImage}
          resizeMode="cover"
          onError={() => setImgFailed(true)}
        />
      ) : (
        <View style={[pg.thumbImage, pg.thumbFallback]}>
          <Camera size={20} color="rgba(250,249,246,0.4)" />
        </View>
      )}
    </Pressable>
  );
}

function DedupGroupCard({ group }: { group: LivingDedupGroup }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <View style={pg.dedupCard}>
      <Pressable onPress={() => setExpanded((e) => !e)} style={pg.dedupBtn}>
        <View style={pg.dedupThumbPlaceholder}>
          <Users size={18} color={color.mute} />
        </View>
        <Text style={pg.dedupText}>
          ＋{group.memberCount - 1} more travelers captured this view
        </Text>
        {expanded
          ? <ChevronUp size={14} color={color.mute} />
          : <ChevronDown size={14} color={color.mute} />}
      </Pressable>
      {expanded && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={pg.dedupStrip}
        >
          {group.sampleUrls.slice(0, 5).map((url, i) => (
            <View key={`${group.groupId}-${i}`} style={pg.dedupThumb}>
              <CachedImage
                source={{ uri: url }}
                style={pg.dedupThumbImage}
                resizeMode="cover"
              />
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

function PlacePostGrid({ posts, dedupGroups = [], onPostPress }: PlacePostGridProps) {
  if (posts.length === 0 && dedupGroups.length === 0) return null;

  const numCols = 2;
  const thumbSize = (SCREEN_WIDTH - space.lg * 2 - space.sm) / numCols;

  return (
    <View style={pg.grid}>
      {/* Dedup group cards */}
      {dedupGroups.map((group) => (
        <DedupGroupCard key={group.groupId} group={group} />
      ))}

      {/* Post thumbnails */}
      <View style={[pg.row, { flexWrap: 'wrap', gap: space.sm }]}>
        {posts.map((post) => (
          <View key={post.id} style={{ width: thumbSize }}>
            <PostThumb
              post={post}
              onPress={onPostPress ? () => onPostPress(post) : undefined}
            />
            {post.caption ? (
              <Text style={pg.caption} numberOfLines={2}>{post.caption}</Text>
            ) : null}
          </View>
        ))}
      </View>
    </View>
  );
}

const pg = StyleSheet.create({
  grid: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
  },
  row: {
    flexDirection: 'row',
  },
  thumb: {
    borderRadius: radius.sm,
    overflow: 'hidden',
    marginBottom: 2,
  },
  thumbImage: {
    width: '100%',
    aspectRatio: aspect.square,
  },
  thumbFallback: {
    backgroundColor: '#1a1a18',
    alignItems: 'center',
    justifyContent: 'center',
  },
  caption: {
    ...typography.caption,
    color: color.mute,
    marginTop: 3,
  },
  dedupCard: {
    backgroundColor: color.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    marginBottom: space.md,
    overflow: 'hidden',
  },
  dedupBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: space.md,
    gap: space.sm,
  },
  dedupThumbPlaceholder: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dedupText: {
    ...typography.caption,
    color: color.ink,
    flex: 1,
  },
  dedupStrip: {
    flexDirection: 'row',
    paddingHorizontal: space.md,
    paddingBottom: space.md,
    gap: space.sm,
  },
  dedupThumb: {
    width: 72,
    height: 72,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  dedupThumbImage: {
    width: '100%',
    height: '100%',
  },
});

// ── PlaceBeFirstCard ──────────────────────────────────────────────────────────

interface PlaceBeFirstCardProps {
  placeName: string;
  bucketLabel: string;
  onPress?: () => void;
}

function PlaceBeFirstCard({ placeName, bucketLabel, onPress }: PlaceBeFirstCardProps) {
  return (
    <View style={bef.card}>
      <Camera size={32} color={color.faint} />
      <Text style={bef.title}>Be the first</Text>
      <Text style={bef.body}>
        No one has shared {bucketLabel.toLowerCase()} shots of {placeName} yet.
      </Text>
      <Pressable
        style={({ pressed }) => [bef.cta, pressed && { opacity: 0.75 }]}
        onPress={onPress}
      >
        <Text style={bef.ctaText}>Share your {bucketLabel}</Text>
      </Pressable>
    </View>
  );
}

const bef = StyleSheet.create({
  card: {
    alignItems: 'center',
    paddingHorizontal: space.xl,
    paddingVertical: space.xl,
    gap: space.sm,
  },
  title: {
    ...t.heading,
    color: color.ink,
    marginTop: space.sm,
  },
  body: {
    ...typography.body,
    color: color.mute,
    textAlign: 'center',
  },
  cta: {
    marginTop: space.md,
    backgroundColor: color.signal,
    borderRadius: radius.pill,
    paddingHorizontal: space.xl,
    paddingVertical: 10,
  },
  ctaText: {
    ...typography.button,
    color: color.onInk,
  },
});

// ── Week-timeline module-level cache ─────────────────────────────────────────

/** How long a cached week-timeline result is considered fresh (5 minutes). */
const WEEK_TIMELINE_CACHE_TTL_MS = 5 * 60 * 1000;

interface WeekTimelineCacheEntry {
  posts: LivingTimelinePost[];
  expiresAt: number;
}

/**
 * Module-level cache — persists across PlaceBucketTabs mounts for the app's
 * lifetime, so navigating away and back within the TTL skips the network call.
 */
const weekTimelineCache = new Map<string, WeekTimelineCacheEntry>();

// ── PlaceBucketTabs ───────────────────────────────────────────────────────────

type ContentTab =
  | { type: 'featured' }
  | { type: 'latest' }
  | { type: 'top_week' }
  | { type: 'bucket'; bucket: string };

interface PlaceBucketTabsProps {
  living: PlaceLivingResponse;
  placeName: string;
  placeId: string;
}

function PlaceBucketTabs({ living, placeName, placeId }: PlaceBucketTabsProps) {
  const [activeTab, setActiveTab] = useState<ContentTab>({ type: 'featured' });
  const [weekPosts, setWeekPosts] = useState<LivingTimelinePost[] | null>(null);
  const [weekLoading, setWeekLoading] = useState(false);

  // Fetch week-slice timeline whenever the top_week tab becomes active.
  // Results are stored in the module-level weekTimelineCache so that
  // navigating away and back within the TTL skips the network request.
  useEffect(() => {
    if (activeTab.type !== 'top_week') return;
    if (weekPosts !== null) return; // already hydrated for this mount

    // Serve from cache if the entry is still fresh
    const cached = weekTimelineCache.get(placeId);
    if (cached && Date.now() < cached.expiresAt) {
      setWeekPosts(cached.posts);
      return;
    }

    let cancelled = false;
    setWeekLoading(true);
    getPlaceTimeline(placeId, 'week')
      .then((result) => {
        if (cancelled) return;
        const posts = result?.posts ?? [];
        weekTimelineCache.set(placeId, {
          posts,
          expiresAt: Date.now() + WEEK_TIMELINE_CACHE_TTL_MS,
        });
        setWeekPosts(posts);
      })
      .catch(() => {
        if (!cancelled) setWeekPosts([]);
      })
      .finally(() => {
        if (!cancelled) setWeekLoading(false);
      });
    return () => { cancelled = true; };
  }, [activeTab.type, placeId, weekPosts]);

  const tabs: ContentTab[] = [
    { type: 'featured' },
    { type: 'latest' },
    { type: 'top_week' },
    ...living.buckets.map((b): ContentTab => ({ type: 'bucket', bucket: b.bucket })),
  ];

  const getTabLabel = (tab: ContentTab): string => {
    if (tab.type === 'featured') return 'Featured';
    if (tab.type === 'latest')   return 'Latest';
    if (tab.type === 'top_week') return 'Top This Week';
    return BUCKET_LABELS[tab.bucket] ?? capitalize(tab.bucket.replace(/_/g, ' '));
  };

  const isActive = (tab: ContentTab): boolean => {
    if (tab.type !== activeTab.type) return false;
    if (tab.type === 'bucket' && activeTab.type === 'bucket') {
      return tab.bucket === activeTab.bucket;
    }
    return true;
  };

  // Resolve posts for the active tab
  const getActivePosts = (): GridPost[] => {
    if (activeTab.type === 'featured') {
      const photos = (living.bestOf?.photos ?? []).slice(0, 20);
      const videos = (living.bestOf?.videos ?? []).slice(0, 10);
      return [...videos, ...photos].map((item, i) => ({
        id: String(item.id ?? i),
        mediaUrl: item.mediaUrl,
        thumbnailUrl: item.thumbnailUrl ?? null,
        caption: item.caption ?? null,
        authorId: null,
        createdAt: null,
      }));
    }
    if (activeTab.type === 'latest') {
      return living.timeline.posts;
    }
    if (activeTab.type === 'top_week') {
      const posts = weekPosts ?? [];
      return [...posts].sort(
        (a, b) => (b.like_count ?? 0) - (a.like_count ?? 0),
      );
    }
    if (activeTab.type === 'bucket') {
      const bucket = living.buckets.find((b) => b.bucket === activeTab.bucket);
      return bucket?.posts ?? [];
    }
    return [];
  };

  const activeBucket =
    activeTab.type === 'bucket'
      ? living.buckets.find((b) => b.bucket === activeTab.bucket) ?? null
      : null;

  const activePosts = getActivePosts();
  const showWeekLoader = activeTab.type === 'top_week' && weekLoading;

  return (
    <View>
      {/* Tab pill row */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={bt.tabRow}
        style={bt.tabScroll}
      >
        {tabs.map((tab) => {
          const active = isActive(tab);
          return (
            <Pressable
              key={`${tab.type}-${tab.type === 'bucket' ? tab.bucket : ''}`}
              style={[bt.tab, active && bt.tabActive]}
              onPress={() => setActiveTab(tab)}
            >
              <Text style={[bt.tabText, active && bt.tabTextActive]}>
                {getTabLabel(tab)}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* Loading indicator for week fetch */}
      {showWeekLoader ? (
        <View style={bt.loadingWrap}>
          <ActivityIndicator size="small" color={color.mute} />
        </View>
      ) : (
        <>
          {/* Grid */}
          <PlacePostGrid
            posts={activePosts}
            dedupGroups={living.dedupGroups}
          />

          {/* Be-first card for thin buckets */}
          {activeBucket?.isThin && (
            <PlaceBeFirstCard
              placeName={placeName}
              bucketLabel={BUCKET_LABELS[activeBucket.bucket] ?? capitalize(activeBucket.bucket.replace(/_/g, ' '))}
              onPress={() =>
                router.push({
                  pathname: '/create',
                  params: {
                    placeId: living.placeId,
                    placeName,
                    bucket: activeBucket.bucket,
                  },
                } as any)
              }
            />
          )}

          {activePosts.length === 0 && !activeBucket?.isThin && (
            <View style={bt.emptyWrap}>
              <Text style={bt.emptyText}>No posts yet.</Text>
            </View>
          )}
        </>
      )}
    </View>
  );
}

const bt = StyleSheet.create({
  tabScroll: {
    backgroundColor: color.paperRaised,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  tabRow: {
    flexDirection: 'row',
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    gap: space.sm,
  },
  tab: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: color.paper,
    borderWidth: 1,
    borderColor: color.haze,
  },
  tabActive: {
    backgroundColor: color.ink,
    borderColor: color.ink,
  },
  tabText: {
    ...typography.label,
    color: color.mute,
  },
  tabTextActive: {
    color: color.onInk,
  },
  emptyWrap: {
    paddingHorizontal: space.lg,
    paddingVertical: space.xl,
    alignItems: 'center',
  },
  emptyText: {
    ...typography.body,
    color: color.mute,
  },
  loadingWrap: {
    paddingVertical: space.xl,
    alignItems: 'center',
  },
});

// ── PlaceLiveStatusBar ────────────────────────────────────────────────────────

interface PlaceLiveStatusBarProps {
  crowdLevel: string | null;
  weatherBrief: string | null;
}

function PlaceLiveStatusBar({ crowdLevel, weatherBrief }: PlaceLiveStatusBarProps) {
  if (!crowdLevel && !weatherBrief) return null;
  const crowdColor = crowdLevel ? (CROWD_COLORS[crowdLevel.toLowerCase()] ?? color.mute) : color.mute;

  return (
    <View style={ls.bar}>
      {crowdLevel ? (
        <View style={ls.item}>
          <Users size={13} color={crowdColor} />
          <Text style={[ls.text, { color: crowdColor }]}>{capitalize(crowdLevel)} crowd now</Text>
        </View>
      ) : null}
      {weatherBrief ? (
        <View style={ls.item}>
          <Cloud size={13} color={color.mute} />
          <Text style={ls.text}>{weatherBrief}</Text>
        </View>
      ) : null}
    </View>
  );
}

const ls = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    backgroundColor: color.paper,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    flexWrap: 'wrap',
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  text: {
    ...typography.caption,
    color: color.mute,
  },
});

// ── PlaceTimelinePicker ───────────────────────────────────────────────────────

const TIMELINE_SLICES: { slice: TimelineSlice; label: string }[] = [
  { slice: 'today',       label: 'Today' },
  { slice: 'week',        label: 'This Week' },
  { slice: 'month',       label: 'This Month' },
  { slice: 'year',        label: 'Last Year' },
  { slice: 'dry_season',  label: 'Dry Season' },
  { slice: 'rainy_season', label: 'Rainy Season' },
];

interface PlaceTimelinePickerProps {
  placeId: string;
  initial: PlaceLivingResponse['timeline'];
}

function PlaceTimelinePicker({ placeId, initial }: PlaceTimelinePickerProps) {
  const [activeSlice, setActiveSlice] = useState<TimelineSlice>('today');
  const [posts, setPosts] = useState<LivingTimelinePost[]>(initial.posts);
  const [crowdLevel, setCrowdLevel] = useState<string | null>(initial.crowdLevel);
  const [weatherBrief, setWeatherBrief] = useState<string | null>(initial.weatherBrief);
  const [loading, setLoading] = useState(false);

  const selectSlice = useCallback(async (slice: TimelineSlice) => {
    if (slice === activeSlice) return;
    setActiveSlice(slice);

    if (slice === 'today') {
      // Already have today's data from the initial payload
      setPosts(initial.posts);
      setCrowdLevel(initial.crowdLevel);
      setWeatherBrief(initial.weatherBrief);
      return;
    }

    setLoading(true);
    try {
      const result = await getPlaceTimeline(placeId, slice);
      if (result) {
        setPosts(result.posts);
        setCrowdLevel(result.crowdLevel);
        setWeatherBrief(result.weatherBrief);
      }
    } catch {
      // keep previous posts on error
    } finally {
      setLoading(false);
    }
  }, [activeSlice, placeId, initial]);

  return (
    <View>
      {/* Section header */}
      <View style={tp.sectionHeader}>
        <Text style={tp.sectionTitle}>Timeline</Text>
      </View>

      {/* Slice pills */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={tp.pillRow}
        style={tp.pillScroll}
      >
        {TIMELINE_SLICES.map(({ slice, label }) => {
          const active = slice === activeSlice;
          return (
            <Pressable
              key={slice}
              style={[tp.pill, active && tp.pillActive]}
              onPress={() => void selectSlice(slice)}
            >
              <Text style={[tp.pillText, active && tp.pillTextActive]}>{label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* Live status bar — only on Today */}
      {activeSlice === 'today' && (
        <PlaceLiveStatusBar crowdLevel={crowdLevel} weatherBrief={weatherBrief} />
      )}

      {/* Loading skeleton */}
      {loading ? (
        <View style={tp.loadingRow}>
          <ActivityIndicator size="small" color={color.signal} />
        </View>
      ) : (
        <PlacePostGrid posts={posts} />
      )}
    </View>
  );
}

const tp = StyleSheet.create({
  sectionHeader: {
    paddingHorizontal: space.lg,
    paddingTop: space.xl,
    paddingBottom: space.sm,
  },
  sectionTitle: {
    ...t.heading,
    color: color.ink,
  },
  pillScroll: {
    backgroundColor: color.paperRaised,
  },
  pillRow: {
    flexDirection: 'row',
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    gap: space.sm,
  },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: color.paper,
    borderWidth: 1,
    borderColor: color.haze,
  },
  pillActive: {
    backgroundColor: color.signal,
    borderColor: color.signal,
  },
  pillText: {
    ...typography.label,
    color: color.mute,
  },
  pillTextActive: {
    color: color.onInk,
  },
  loadingRow: {
    padding: space.xl,
    alignItems: 'center',
  },
});

// ── PlaceBestOfShelf ──────────────────────────────────────────────────────────

interface PlaceBestOfShelfProps {
  title: string;
  items: LivingBestOfItem[];
  onItemPress?: (item: LivingBestOfItem) => void;
}

function PlaceBestOfShelf({ title, items, onItemPress }: PlaceBestOfShelfProps) {
  const [laid, setLaid] = useState(false);

  if (items.length === 0) return null;

  return (
    <View onLayout={() => setLaid(true)}>
      <View style={shelf.header}>
        <Text style={shelf.title}>{title}</Text>
      </View>
      {laid && (
        <FlatList
          data={items}
          keyExtractor={(item, i) => String(item.id ?? i)}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={shelf.list}
          renderItem={({ item }) => {
            const url = item.thumbnailUrl ?? item.mediaUrl ?? null;
            return (
              <Pressable
                style={({ pressed }) => [shelf.card, pressed && { opacity: 0.85 }]}
                onPress={onItemPress ? () => onItemPress(item) : undefined}
              >
                {url ? (
                  <CachedImage
                    source={{ uri: url }}
                    style={shelf.thumb}
                    resizeMode="cover"
                  />
                ) : (
                  <View style={[shelf.thumb, shelf.thumbFallback]}>
                    <ImageIcon size={24} color="rgba(250,249,246,0.4)" />
                  </View>
                )}
                {item.title ? (
                  <Text style={shelf.cardTitle} numberOfLines={1}>{item.title}</Text>
                ) : null}
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

const SHELF_CARD_WIDTH = 140;

const shelf = StyleSheet.create({
  header: {
    paddingHorizontal: space.lg,
    paddingTop: space.xl,
    paddingBottom: space.sm,
  },
  title: {
    ...t.heading,
    color: color.ink,
  },
  list: {
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    gap: space.sm,
  },
  card: {
    width: SHELF_CARD_WIDTH,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
  },
  thumb: {
    width: SHELF_CARD_WIDTH,
    height: SHELF_CARD_WIDTH * 0.65,
  },
  thumbFallback: {
    backgroundColor: '#1a1a18',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: {
    ...typography.label,
    color: color.ink,
    padding: 6,
  },
});

// ── PlaceTopContributorChip ───────────────────────────────────────────────────

interface PlaceTopContributorChipProps {
  contributor: NonNullable<PlaceLivingResponse['topContributor']>;
}

function PlaceTopContributorChip({ contributor }: PlaceTopContributorChipProps) {
  const name = contributor.displayName ?? 'Traveler';

  return (
    <View style={tc.wrap}>
      <View style={tc.chip}>
        {contributor.avatarUrl ? (
          <CachedImage
            source={{ uri: contributor.avatarUrl }}
            style={tc.avatar}
            resizeMode="cover"
          />
        ) : (
          <View style={[tc.avatar, tc.avatarFallback]}>
            <Award size={12} color={color.onInk} />
          </View>
        )}
        <Text style={tc.label}>Top contributor · {name}</Text>
      </View>
    </View>
  );
}

const tc = StyleSheet.create({
  wrap: {
    paddingHorizontal: space.lg,
    paddingTop: space.xl,
    paddingBottom: space.md,
    alignItems: 'center',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.paper,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  avatar: {
    width: icon.s22, height: icon.s22,
    borderRadius: icon.s22 / 2,
  },
  avatarFallback: {
    backgroundColor: color.deep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    ...typography.caption,
    color: color.mute,
  },
});

// ── LivingDestinationPage ─────────────────────────────────────────────────────

export interface LivingDestinationPageProps {
  place: CanonicalPlace;
  living: PlaceLivingResponse;
  placeDaysEnabled?: boolean;
}

export function LivingDestinationPage({ place, living, placeDaysEnabled = false }: LivingDestinationPageProps) {
  const scrollY = useRef(new Animated.Value(0)).current;

  // Compact header opacity — fades in as the hero scrolls away
  const compactHeaderOpacity = scrollY.interpolate({
    inputRange: [HERO_COLLAPSE_DISTANCE - 20, HERO_COLLAPSE_DISTANCE],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });

  const { sparseMode } = living;

  return (
    <View style={ld.root}>
      {/* Compact sticky header — fades in on scroll */}
      <Animated.View
        style={[ld.compactHeader, { opacity: compactHeaderOpacity }]}
        pointerEvents="none"
      >
        <Text style={ld.compactTitle} numberOfLines={1}>{place.name}</Text>
      </Animated.View>

      <Animated.ScrollView
        style={ld.scroll}
        scrollEventThrottle={16}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: false },
        )}
        contentContainerStyle={ld.content}
      >
        {/* ── Hero ── */}
        <PlaceHeroCarousel living={living} place={place} />

        {/* ── Info strip ── */}
        <PlaceInfoStrip living={living} placeName={place.name} category={place.category} />

        {/* ── Directions ── */}
        {living.directionsUrl ? (
          <PlaceDirectionsRow directionsUrl={living.directionsUrl} />
        ) : null}
        {placeDaysEnabled ? (
          <Pressable
            testID="place-day-entry"
            style={ld.placeDayEntry}
            onPress={() => router.push({ pathname: '/place/[id]/day', params: { id: living.placeId } } as any)}
          >
            <CalendarDays size={18} color={color.deep} />
            <View style={{ flex: 1 }}>
              <Text style={ld.placeDayEntryTitle}>Today at this place</Text>
              <Text style={ld.placeDayEntryBody}>See community posts from this local day.</Text>
            </View>
            <ChevronDown size={18} color={color.mute} />
          </Pressable>
        ) : null}

        {/* ── Official info card ── */}
        <PlaceOfficialInfoCard info={living.officialInfo} />

        {/* ── AI summary ── */}
        {living.aiSummary ? (
          <PlaceAiSummaryCard summary={living.aiSummary} />
        ) : null}

        {/* ── Sparse mode: Be-first CTA ── */}
        {sparseMode ? (
          <View style={ld.beFirstWrap}>
            <Camera size={32} color={color.faint} />
            <Text style={ld.beFirstTitle}>Be the first to share {place.name}</Text>
            <Text style={ld.beFirstBody}>
              Help future travelers by sharing photos, tips, or a quick review.
            </Text>
            <Pressable
              style={({ pressed }) => [ld.beFirstBtn, pressed && { opacity: 0.75 }]}
              onPress={() =>
                router.push({
                  pathname: '/create',
                  params: { placeId: living.placeId, placeName: place.name },
                } as any)
              }
            >
              <Text style={ld.beFirstBtnText}>Share a moment here</Text>
            </Pressable>
          </View>
        ) : (
          <>
            {/* ── Community content tabs ── */}
            <View style={ld.sectionHeader}>
              <Text style={ld.sectionTitle}>Community</Text>
            </View>
            <PlaceBucketTabs living={living} placeName={place.name} placeId={living.placeId} />

            {/* ── Timeline ── */}
            <PlaceTimelinePicker
              placeId={living.placeId}
              initial={living.timeline}
            />

            {/* ── Best-of shelves ── */}
            {living.bestOf && living.bestOf.videos.length > 0 && (
              <PlaceBestOfShelf
                title="Top Videos"
                items={living.bestOf.videos.slice(0, 15)}
              />
            )}
            {living.bestOf && living.bestOf.photos.length > 0 && (
              <PlaceBestOfShelf
                title="Top Photos"
                items={living.bestOf.photos.slice(0, 15)}
              />
            )}
            {living.bestOf && living.bestOf.viewpoints.length > 0 && (
              <PlaceBestOfShelf
                title="Viewpoints"
                items={living.bestOf.viewpoints}
              />
            )}
            {living.bestOf && living.bestOf.foodNearby.length > 0 && (
              <PlaceBestOfShelf
                title="Nearby Food"
                items={living.bestOf.foodNearby}
              />
            )}
          </>
        )}

        {/* ── Top contributor ── */}
        {living.topContributor ? (
          <PlaceTopContributorChip contributor={living.topContributor} />
        ) : null}

        <View style={ld.bottomPad} />
      </Animated.ScrollView>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const ld = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.paper,
  },
  compactHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: COMPACT_HEADER_HEIGHT,
    backgroundColor: color.paperRaised,
    justifyContent: 'flex-end',
    paddingBottom: 10,
    paddingHorizontal: space.lg,
    zIndex: 10,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    ...shadow.card,
  },
  compactTitle: {
    ...t.heading,
    color: color.ink,
    fontSize: 17,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingBottom: 0,
  },
  sectionHeader: {
    paddingHorizontal: space.lg,
    paddingTop: space.xl,
    paddingBottom: space.sm,
  },
  sectionTitle: {
    ...t.heading,
    color: color.ink,
  },
  beFirstWrap: {
    marginHorizontal: space.lg,
    marginTop: space.xl,
    padding: space.xl,
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
  },
  placeDayEntry: {
    marginHorizontal: space.lg,
    marginTop: space.md,
    padding: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: '#EAF5F5',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#CDE4E3',
  },
  placeDayEntryTitle: { ...typography.label, color: color.deep },
  placeDayEntryBody: { ...typography.caption, color: color.mute, marginTop: 2 },
  beFirstTitle: {
    ...t.heading,
    color: color.ink,
    textAlign: 'center',
    marginTop: space.sm,
  },
  beFirstBody: {
    ...typography.body,
    color: color.mute,
    textAlign: 'center',
  },
  beFirstBtn: {
    marginTop: space.md,
    backgroundColor: color.signal,
    borderRadius: radius.pill,
    paddingHorizontal: space.xl,
    paddingVertical: 10,
  },
  beFirstBtnText: {
    ...typography.button,
    color: color.onInk,
  },
  bottomPad: {
    height: 80,
  },
});

// ── Utilities ─────────────────────────────────────────────────────────────────

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
