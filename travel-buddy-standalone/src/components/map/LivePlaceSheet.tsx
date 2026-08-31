/**
 * LivePlaceSheet — Map spec §8 "Live Place Surface", presented per §32.
 *
 * §32: "Three snap points: Peek ~15-20%, Half ~45-55%, Full ~90-95%. Map stays
 * visible behind Peek and Half states." So this is NOT a Modal: a Modal would
 * put an opaque host view over the map and make it untouchable at every snap
 * point. It is an absolutely-positioned overlay with `pointerEvents="box-none"`,
 * which leaves the map both VISIBLE and INTERACTIVE at Peek and Half. A scrim
 * appears only at Full, where the map is genuinely covered.
 *
 * §8's sections, in order: hero, name · type · distance, LIVE STATE, CROWD /
 * TREND / VIBE, SOCIAL, ACCESS, WHY SHOWN, ACTIONS.
 *
 * Every section is optional and the decision about whether it may render is
 * `livePlaceModel`'s, not this file's. A place with no live claim renders no
 * LIVE STATE block — not "Quiet". Where a section is missing and the object
 * accepts contributions, §22's one-tap prompt takes its place, which is the
 * honest way to fill a hole: ask, rather than guess.
 *
 * §9's Why? affordance sits next to the live state. It is a callback, not a
 * sheet — `WhyShownSheet` is owned elsewhere.
 *
 * Dark-mode-first (§4).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { HelpCircle, Image as ImageIcon, Plus, X } from 'lucide-react-native';
import { avatar, dot, radius, space, type as t } from '../../theme/tokens.ts';
import { DisplayMediaImage } from '../ui/DisplayMediaImage.tsx';
import {
  isForecastKind,
  type MapAction,
  type MapObject,
  type MapObjectKind,
} from '../../types/mapObjects.ts';
import {
  clearActiveDecision,
  currentDecisionId,
  describeMapObject,
  distanceBucket,
  durationBucketMs,
  emitMapEvent,
  type PlaceOpenSource,
} from '../../features/map/telemetry/mapTelemetry.ts';
import {
  LIVE_PLACE_ACTION_LABELS,
  buildLivePlaceView,
  isSectionMissing,
  liveStateHeadline,
  missingReason,
  placeMetaLine,
  type LivePlaceContext,
  type LivePlaceDetail,
  type LivePlaceViewModel,
} from '../../features/map/place/livePlaceModel.ts';

// ── §32 snap points ───────────────────────────────────────────────────────────

export const LIVE_PLACE_SNAP_FRACTIONS = {
  /** §32 "Peek ~15-20%". */
  peek: 0.18,
  /** §32 "Half ~45-55%". */
  half: 0.5,
  /** §32 "Full ~90-95%". */
  full: 0.92,
} as const;

export type LivePlaceSnapPoint = keyof typeof LIVE_PLACE_SNAP_FRACTIONS;

/** Ordered smallest to largest, so a drag can step to the neighbouring snap. */
export const SNAP_ORDER: readonly LivePlaceSnapPoint[] = ['peek', 'half', 'full'];

/** §18 kinds that are zones/forecasts rather than places (§35 `zone_selected`). */
const TELEMETRY_ZONE_KINDS: readonly MapObjectKind[] = [
  'activity_zone',
  'crowd_flow',
  'social_zone',
  'prediction',
];

/** The snap point whose height is nearest a dragged height. */
export function nearestSnap(fraction: number): LivePlaceSnapPoint {
  let best: LivePlaceSnapPoint = 'peek';
  let bestDist = Number.POSITIVE_INFINITY;
  for (const snap of SNAP_ORDER) {
    const d = Math.abs(LIVE_PLACE_SNAP_FRACTIONS[snap] - fraction);
    if (d < bestDist) {
      bestDist = d;
      best = snap;
    }
  }
  return best;
}

// ── Dark-mode-first palette (§4) ──────────────────────────────────────────────

const dark = {
  sheet: '#0E1216',
  raised: '#171C22',
  raisedAlt: '#1F262E',
  hairline: '#2A323B',
  text: '#F2F5F7',
  textMute: 'rgba(242,245,247,0.62)',
  textFaint: 'rgba(242,245,247,0.40)',
  scrim: 'rgba(4,6,8,0.55)',
  accent: '#FF4D2E',
  live: '#34D399',
  onAccent: '#0E1216',
} as const;

// ── Small pieces ──────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <Text style={s.sectionLabel}>{children}</Text>;
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.statRow}>
      <Text style={s.statLabel}>{label}</Text>
      <Text style={s.statValue}>{value}</Text>
    </View>
  );
}

/**
 * §22's one-tap contribution prompt, used where a §8 section could not be
 * built. The copy names the gap in the model's own words instead of inventing
 * a value to fill it.
 */
function ContributePrompt({ reason, onPress }: { reason: string; onPress: () => void }) {
  return (
    <Pressable style={s.contribute} onPress={onPress} accessibilityRole="button">
      <Plus size={13} color={dark.accent} />
      <Text style={s.contributeText} numberOfLines={2}>
        {reason}. Add what you see?
      </Text>
    </Pressable>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export interface LivePlaceSheetProps {
  /** The selected object. `null` closes the sheet. */
  object: MapObject | null;
  /** §8 fields fetched with the place detail. Absent sections simply don't render. */
  detail?: LivePlaceDetail | null;
  /**
   * WHY SHOWN inputs. `now` is supplied by the sheet (and ticked while open),
   * so the caller passes only the viewer-relative facts.
   */
  whyContext?: Omit<LivePlaceContext, 'now'>;
  /** Which snap point to open at. Defaults to Peek, per §8's "bottom sheet". */
  initialSnap?: LivePlaceSnapPoint;
  /**
   * §35 `place_opened.source` — how the object under this sheet was reached.
   * Only the caller knows; it defaults to 'marker' because that is how the map
   * screen opens the sheet today. Pass 'compass_pick' when the object came from
   * a Compass recommendation: that is ALSO what arms `recommendation_declined`
   * on dismissal, so a pick abandoned without action is recorded as the
   * negative arm of the decision instead of silently vanishing.
   */
  openSource?: PlaceOpenSource;
  onClose: () => void;
  /** §9 Why? — opens the provenance surface, which another module owns. */
  onWhyPress?: (object: MapObject) => void;
  /** §8 ACTIONS. Every action re-authorizes server-side. */
  onAction?: (action: MapAction, object: MapObject) => void;
  /** §22 one-tap contribution for a section the projection could not fill. */
  onContribute?: (object: MapObject) => void;
  onSnapChange?: (snap: LivePlaceSnapPoint) => void;
}

export function LivePlaceSheet({
  object,
  detail,
  whyContext,
  initialSnap = 'peek',
  openSource = 'marker',
  onClose,
  onWhyPress,
  onAction,
  onContribute,
  onSnapChange,
}: LivePlaceSheetProps) {
  const { height: screenH, width: screenW } = useWindowDimensions();
  const sheetH = screenH * LIVE_PLACE_SNAP_FRACTIONS.full;

  const [snap, setSnap] = useState<LivePlaceSnapPoint>(initialSnap);
  const translateY = useRef(new Animated.Value(sheetH)).current;
  const snapRef = useRef<LivePlaceSnapPoint>(initialSnap);
  const dragStartY = useRef(0);

  /** Offset from the sheet's fully-open position for a given snap point. */
  const offsetFor = useCallback(
    (point: LivePlaceSnapPoint) => sheetH - screenH * LIVE_PLACE_SNAP_FRACTIONS[point],
    [sheetH, screenH],
  );

  const animateTo = useCallback(
    (point: LivePlaceSnapPoint) => {
      snapRef.current = point;
      setSnap(point);
      onSnapChange?.(point);
      Animated.spring(translateY, {
        toValue: offsetFor(point),
        useNativeDriver: true,
        damping: 24,
        stiffness: 220,
        mass: 0.8,
      }).start();
    },
    [offsetFor, onSnapChange, translateY],
  );

  // Open at the initial snap when an object arrives; slide away when it clears.
  useEffect(() => {
    if (object) {
      snapRef.current = initialSnap;
      setSnap(initialSnap);
      Animated.spring(translateY, {
        toValue: offsetFor(initialSnap),
        useNativeDriver: true,
        damping: 24,
        stiffness: 220,
        mass: 0.8,
      }).start();
    } else {
      Animated.timing(translateY, {
        toValue: sheetH,
        duration: 180,
        useNativeDriver: true,
      }).start();
    }
    // `object?.id` rather than `object` so a re-fetch of the same place does not
    // yank the sheet back to Peek while the user is reading it at Full.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [object?.id, initialSnap, offsetFor, sheetH]);

  // §7 freshness is a moving target: "Updated 4 min ago" must not freeze at 4.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!object) return undefined;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [object]);

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_evt, gesture) => Math.abs(gesture.dy) > 4,
      onPanResponderGrant: () => {
        dragStartY.current = offsetFor(snapRef.current);
      },
      onPanResponderMove: (_evt, gesture) => {
        const next = Math.min(sheetH, Math.max(0, dragStartY.current + gesture.dy));
        translateY.setValue(next);
      },
      onPanResponderRelease: (_evt, gesture) => {
        const settled = Math.min(sheetH, Math.max(0, dragStartY.current + gesture.dy));
        // Height the sheet currently shows, as a fraction of the screen.
        const shownFraction = (sheetH - settled) / screenH;
        // A firm flick past the Peek floor is a dismissal, not a snap.
        if (gesture.vy > 1.2 && snapRef.current === 'peek') {
          // Ref indirection: the PanResponder is created once, so it must not
          // capture the first render's close handler.
          handleCloseRef.current();
          return;
        }
        animateTo(nearestSnap(shownFraction));
      },
    }),
  ).current;

  const vm: LivePlaceViewModel | null = useMemo(() => {
    if (!object) return null;
    return buildLivePlaceView(object, detail ?? null, { now, ...(whyContext ?? {}) });
  }, [object, detail, whyContext, now]);

  // ── §35 telemetry ─────────────────────────────────────────────────────────
  //
  // Everything below is fire-and-forget: it never blocks, reorders or gates a
  // user action, and every object reaches a payload through describeMapObject.

  // The live object, held in a ref so the effects below can key on `object.id`
  // (a re-fetch of the same place must not re-fire an "opened") and still read
  // the current object, and so an unmount cleanup can still describe the object
  // that was on screen.
  const objectRef = useRef<MapObject | null>(object);
  objectRef.current = object;

  const isRecommendation = openSource === 'compass_pick';
  /** Set when this sheet emitted an acceptance, so dismissal is not a decline. */
  const acceptedRef = useRef(false);

  // `place_opened` / `zone_selected` — once per object that opens the sheet.
  useEffect(() => {
    const obj = objectRef.current;
    if (!obj) return;
    acceptedRef.current = false;
    try {
      if (TELEMETRY_ZONE_KINDS.includes(obj.kind)) {
        emitMapEvent('zone_selected', {
          ref: describeMapObject(obj),
          source: isRecommendation ? 'compass_pick' : 'marker',
          forecast: isForecastKind(obj.kind),
        });
      } else {
        emitMapEvent('place_opened', {
          ref: describeMapObject(obj),
          source: openSource,
        });
      }
    } catch {
      // Deliberately swallowed.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [object?.id, openSource]);

  // `live_state_viewed` — only when the LIVE STATE block is genuinely on
  // screen. At Peek the sheet shows ~18% of the screen: the block is mounted
  // inside the ScrollView but clipped away, and reporting that as "viewed"
  // would measure mounting rather than reading. Detent changes re-report,
  // which is what makes "did they actually open it to read this" answerable.
  const hasLiveState = vm?.liveState != null;
  const visibleDetent: 'half' | 'full' | null =
    snap === 'peek' ? null : snap === 'half' ? 'half' : 'full';
  const liveAxesRef = useRef<{ activity?: string; trend?: string }>({});
  liveAxesRef.current = {
    activity: vm?.crowd?.crowdLabel ?? undefined,
    trend: vm?.crowd?.trendLabel ?? undefined,
  };
  const lastDetentRef = useRef<LivePlaceSnapPoint | null>(null);
  const liveStateShownAtRef = useRef<number | null>(null);

  useEffect(() => {
    const obj = objectRef.current;
    if (!obj || !hasLiveState || !visibleDetent) return;
    if (liveStateShownAtRef.current == null) liveStateShownAtRef.current = Date.now();
    lastDetentRef.current = visibleDetent;
    const axes = liveAxesRef.current;
    try {
      emitMapEvent('live_state_viewed', {
        ref: describeMapObject(obj),
        // The §7 axes AS DISPLAYED — the sheet's own claim, not a re-derivation.
        ...(axes.activity ? { activity: axes.activity } : {}),
        ...(axes.trend ? { trend: axes.trend } : {}),
        detent: visibleDetent,
      });
    } catch {
      // Deliberately swallowed.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [object?.id, hasLiveState, visibleDetent]);

  // Dwell, banded, when the live state leaves the screen (object swapped or
  // sheet unmounted). Emitted only if it was ever actually shown.
  useEffect(() => {
    const obj = objectRef.current;
    return () => {
      const shownAt = liveStateShownAtRef.current;
      liveStateShownAtRef.current = null;
      const detent = lastDetentRef.current;
      lastDetentRef.current = null;
      if (!obj || shownAt == null) return;
      try {
        emitMapEvent('live_state_viewed', {
          ref: describeMapObject(obj),
          ...(detent ? { detent } : {}),
          dwell: durationBucketMs(Date.now() - shownAt),
        });
      } catch {
        // Deliberately swallowed.
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [object?.id]);

  /**
   * Dismissal. A Compass pick closed without any acceptance is §35's negative
   * arm: `recommendation_declined` with `explicit: false` (the user never said
   * why — they just left), followed by `clearActiveDecision()` so a later,
   * unrelated route or contribution is not attributed to this recommendation.
   */
  const handleClose = useCallback(() => {
    try {
      const obj = objectRef.current;
      if (isRecommendation && !acceptedRef.current && obj && currentDecisionId() !== null) {
        emitMapEvent('recommendation_declined', {
          ref: describeMapObject(obj),
          reason: 'unspecified',
          explicit: false,
        });
        clearActiveDecision();
      }
    } catch {
      // Deliberately swallowed.
    }
    onClose();
  }, [isRecommendation, onClose]);
  const handleCloseRef = useRef(handleClose);
  handleCloseRef.current = handleClose;

  if (!object || !vm) return null;

  /**
   * §8 ACTIONS. The sheet does not perform them — it hands off to `onAction`.
   * So an event is emitted only when there IS a handler: with none, the button
   * is inert and reporting `route_started` would record a route nothing started.
   *
   * Only 'navigate' is instrumented here. 'add_to_trip', 'meet_here', 'save'
   * and 'join' all COMPLETE somewhere else (a picker, a create call), and this
   * seam cannot see whether they succeeded — see the report notes.
   */
  function handleAction(action: MapAction, obj: MapObject): void {
    if (!onAction) return;
    try {
      if (action === 'navigate') {
        if (isRecommendation && currentDecisionId() !== null) {
          emitMapEvent('recommendation_accepted', {
            ref: describeMapObject(obj),
            via: 'route',
          });
          acceptedRef.current = true;
        }
        emitMapEvent('route_started', {
          ref: describeMapObject(obj),
          // The travel mode and ETA belong to whatever the caller routes with;
          // `external` is likewise unknown at this seam, so none are invented.
          travelMode: 'unknown',
          distance: distanceBucket(obj.distanceKm ?? null),
        });
      }
    } catch {
      // Deliberately swallowed.
    }
    onAction(action, obj);
  }

  const metaLine = placeMetaLine(vm);
  const headline = liveStateHeadline(vm.liveState);
  const canContribute = object.interaction?.contributable === true;
  const heroWidth = screenW;

  const scrimOpacity = translateY.interpolate({
    inputRange: [offsetFor('half'), offsetFor('full')],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });

  return (
    <View style={s.root} pointerEvents="box-none">
      {/* Scrim only at Full — §32 keeps the map visible behind Peek and Half. */}
      <Animated.View
        style={[s.scrim, { opacity: scrimOpacity }]}
        pointerEvents={snap === 'full' ? 'auto' : 'none'}
      >
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={() => animateTo('half')}
          accessibilityLabel="Collapse place details"
        />
      </Animated.View>

      <Animated.View style={[s.sheet, { height: sheetH, transform: [{ translateY }] }]}>
        {/* Drag region — the PanResponder lives here so the ScrollView below
            keeps its own gestures at Full. */}
        <View {...pan.panHandlers} style={s.dragRegion}>
          <View style={s.handle} />
        </View>

        <Pressable style={s.closeBtn} onPress={handleClose} hitSlop={8} accessibilityLabel="Close">
          <X size={16} color={dark.textMute} />
        </Pressable>

        <ScrollView
          style={s.scroll}
          contentContainerStyle={s.scrollContent}
          showsVerticalScrollIndicator={false}
          scrollEnabled={snap === 'full'}
        >
          {/* ── Hero photo / recent Moment ── */}
          {vm.heroPhotoUrl ? (
            <View style={s.hero}>
              <DisplayMediaImage
                uri={vm.heroPhotoUrl}
                width={heroWidth}
                height={168}
                alt={vm.title}
                fallbackBg={dark.raisedAlt}
                fallbackIcon={<ImageIcon size={22} color={dark.textFaint} />}
              />
              {vm.heroIsMoment ? (
                <View style={s.heroBadge}>
                  <Text style={s.heroBadgeText}>RECENT MOMENT</Text>
                </View>
              ) : null}
            </View>
          ) : null}

          <View style={s.body}>
            {/* ── Name · type · distance ── */}
            <Text style={s.title} numberOfLines={2}>
              {vm.title}
            </Text>
            {metaLine ? <Text style={s.meta}>{metaLine}</Text> : null}
            {vm.subtitle ? (
              <Text style={s.subtitle} numberOfLines={2}>
                {vm.subtitle}
              </Text>
            ) : null}

            {/* ── LIVE STATE (§8) + Why? (§9) ── */}
            {vm.liveState ? (
              <View style={s.block}>
                <View style={s.blockHead}>
                  <SectionLabel>LIVE STATE</SectionLabel>
                  {onWhyPress ? (
                    <Pressable
                      style={s.whyBtn}
                      onPress={() => onWhyPress(object)}
                      hitSlop={6}
                      accessibilityRole="button"
                      accessibilityLabel="Why Portava says this"
                    >
                      <HelpCircle size={12} color={dark.textMute} />
                      <Text style={s.whyText}>Why?</Text>
                    </Pressable>
                  ) : null}
                </View>

                <View style={s.headlineRow}>
                  {vm.liveState.isLive ? <View style={s.livePip} /> : null}
                  <Text style={s.headline}>{headline}</Text>
                </View>

                <View style={s.freshnessRow}>
                  {vm.liveState.updatedLabel ? (
                    <Text style={s.freshness}>{vm.liveState.updatedLabel}</Text>
                  ) : null}
                  {vm.liveState.confidenceLabel ? (
                    <View style={s.confidencePill}>
                      <Text style={s.confidenceText}>{vm.liveState.confidenceLabel}</Text>
                    </View>
                  ) : null}
                </View>
              </View>
            ) : canContribute && isSectionMissing(vm, 'live_state') ? (
              <View style={s.block}>
                <SectionLabel>LIVE STATE</SectionLabel>
                <ContributePrompt
                  reason={missingReason(vm, 'live_state') ?? 'No live reading here'}
                  onPress={() => onContribute?.(object)}
                />
              </View>
            ) : null}

            {/* ── CROWD / TREND / VIBE ── */}
            {vm.crowd ? (
              <View style={s.block}>
                {vm.crowd.crowdLabel ? <StatRow label="Crowd" value={vm.crowd.crowdLabel} /> : null}
                {vm.crowd.trendLabel ? <StatRow label="Trend" value={vm.crowd.trendLabel} /> : null}
                {vm.crowd.vibeLabel ? <StatRow label="Vibe" value={vm.crowd.vibeLabel} /> : null}
              </View>
            ) : null}

            {/* ── SOCIAL ── */}
            {vm.social ? (
              <View style={s.block}>
                <SectionLabel>SOCIAL</SectionLabel>
                {vm.social.friendsHereLabel ? (
                  <Text style={s.line}>{vm.social.friendsHereLabel}</Text>
                ) : null}
                {vm.social.travelersInterestedLabel ? (
                  <Text style={s.line}>{vm.social.travelersInterestedLabel}</Text>
                ) : null}
                {vm.social.suppressed ? (
                  <Text style={s.privacyNote}>Presence here is shown in aggregate only.</Text>
                ) : null}
              </View>
            ) : null}

            {/* ── ACCESS ── */}
            {vm.access ? (
              <View style={s.block}>
                <SectionLabel>ACCESS</SectionLabel>
                <View style={s.chipRow}>
                  {vm.access.queueLabel ? (
                    <View style={s.chip}>
                      <Text style={s.chipText}>{vm.access.queueLabel}</Text>
                    </View>
                  ) : null}
                  {vm.access.openUntilLabel ? (
                    <View style={s.chip}>
                      <Text style={s.chipText}>{vm.access.openUntilLabel}</Text>
                    </View>
                  ) : null}
                  {vm.access.priceLabel ? (
                    <View style={s.chip}>
                      <Text style={s.chipText}>{vm.access.priceLabel}</Text>
                    </View>
                  ) : null}
                </View>
              </View>
            ) : null}

            {/* ── WHY SHOWN ── */}
            {vm.whyShown.length > 0 ? (
              <View style={s.block}>
                <SectionLabel>WHY SHOWN</SectionLabel>
                {vm.whyShown.map((line) => (
                  <View key={line.code} style={s.whyLine}>
                    <View style={s.whyDot} />
                    <Text style={s.line}>{line.text}</Text>
                  </View>
                ))}
              </View>
            ) : null}

            {/* ── ACTIONS ── */}
            {vm.actions.length > 0 ? (
              <View style={s.block}>
                <SectionLabel>ACTIONS</SectionLabel>
                <View style={s.actionRow}>
                  {vm.actions.map((action) => (
                    <Pressable
                      key={action}
                      style={s.actionBtn}
                      onPress={() => handleAction(action, object)}
                      accessibilityRole="button"
                      accessibilityLabel={LIVE_PLACE_ACTION_LABELS[action]}
                    >
                      <Text style={s.actionText}>{LIVE_PLACE_ACTION_LABELS[action]}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : null}
          </View>
        </ScrollView>
      </Animated.View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: { ...StyleSheet.absoluteFillObject, zIndex: 40 },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: dark.scrim },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: dark.sheet,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderColor: dark.hairline,
    overflow: 'hidden',
  },
  dragRegion: { paddingTop: 8, paddingBottom: 6, alignItems: 'center' },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: dark.hairline },
  closeBtn: {
    position: 'absolute',
    right: 12,
    top: 10,
    zIndex: 2,
    width: avatar.s30,
    height: avatar.s30,
    borderRadius: avatar.s30 / 2,
    backgroundColor: dark.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 32 },

  hero: { width: '100%', height: 168, backgroundColor: dark.raisedAlt },
  heroBadge: {
    position: 'absolute',
    left: 12,
    bottom: 10,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(14,18,22,0.78)',
  },
  heroBadgeText: { ...t.stamp, fontSize: 9, letterSpacing: 1, color: dark.text },

  body: { paddingHorizontal: space.lg, paddingTop: space.md },
  title: { ...t.title, fontSize: 20, color: dark.text },
  meta: { ...t.small, fontSize: 12, color: dark.textMute, marginTop: 3 },
  subtitle: { ...t.small, fontSize: 12, color: dark.textFaint, marginTop: 3 },

  block: {
    marginTop: space.lg,
    backgroundColor: dark.raised,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  blockHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionLabel: { ...t.stamp, fontSize: 10, letterSpacing: 1.2, color: dark.textFaint },

  headlineRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 6 },
  livePip: { width: dot.s7, height: dot.s7, borderRadius: dot.s7 / 2, backgroundColor: dark.live },
  headline: { ...t.heading, fontSize: 17, color: dark.text, flex: 1 },
  freshnessRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  freshness: { ...t.small, fontSize: 11, color: dark.textMute },
  confidencePill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: dark.raisedAlt,
  },
  confidenceText: { ...t.small, fontSize: 10, color: dark.textMute },

  whyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: dark.raisedAlt,
  },
  whyText: { ...t.small, fontSize: 11, color: dark.textMute },

  statRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 5,
  },
  statLabel: { ...t.small, fontSize: 12, color: dark.textMute },
  statValue: { ...t.bodyStrong, fontSize: 13, color: dark.text },

  line: { ...t.body, fontSize: 13, color: dark.text, marginTop: 5 },
  privacyNote: { ...t.small, fontSize: 11, color: dark.textFaint, marginTop: 6 },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: dark.raisedAlt,
  },
  chipText: { ...t.small, fontSize: 11, color: dark.text },

  whyLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  whyDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: dark.accent, marginTop: 5 },

  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 9 },
  actionBtn: {
    minHeight: 38,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    backgroundColor: dark.raisedAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionText: { ...t.bodyStrong, fontSize: 13, color: dark.text },

  contribute: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: radius.sm,
    backgroundColor: dark.raisedAlt,
  },
  contributeText: { ...t.small, fontSize: 12, color: dark.textMute, flex: 1 },
});
