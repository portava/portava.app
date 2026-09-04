/**
 * CompassChatBlocks — Phase 5 dynamic UI rendering for Compass chat replies.
 *
 * Maps server-validated `uiBlocks` (every entity backed by real Phase 4 tool
 * data — real ids, real handles, real coordinates) plus the itinerary payload
 * to inline chat interfaces:
 *
 *   place_cards → compact place cards   (tap → map focus / search fallback)
 *   event_cards → compact event cards   (tap → /event/[id])
 *   person_cards → circle-member cards  (tap → /u/[handle])
 *   map          → map preview rows     (tap → /map centered on the place)
 *   comparison   → comparison table     (row tap → the entity's screen)
 *   itinerary payload → day timeline
 *
 * No dead ends: every card and row navigates to a real screen, and place
 * cards expose "Plan" through the existing PlanPicker flow (user-confirmed;
 * mutations never fire from a bare tap).
 */
import React, { useCallback, useState } from 'react';
import { View, Text, Pressable, Modal, StyleSheet, Image, Linking } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import {
  MapPin, CalendarClock, ChevronRight, Users, Map as MapIcon, Plus, Star, Sparkles, Navigation,
} from 'lucide-react-native';
import {
  reportCompassViewed,
  type CompassUiBlock, type CompassUiPlace, type CompassUiEvent, type CompassUiPerson,
  type CompassComparisonRow, type CompassAskPayload, type CompassUiConfidence,
} from '../../services/compass.ts';
import { getPlaceCategoryFallback } from '../../utils/placeCategoryFallback.ts';
import { resolveHeaderImage } from '../../lib/visuals/resolveHeaderImage.ts';
import type { HeaderCandidate } from '../../lib/visuals/resolveHeaderImage.ts';
import { fallbackUriFor } from '../../lib/visuals/fallbackAssets.ts';
import { AiRepresentationLabel } from '../visuals/AiRepresentationLabel.tsx';
import { formatCompassEventChip } from '../../utils/compassFormat.ts';
import { CompassMiniMap } from './CompassMiniMap';
import { CompassWhySheet } from './CompassWhySheet.tsx';
import {
  haversineKm, formatDistanceKm, type CompassMiniMapPoint,
} from './compassMiniMapShared.ts';
import { color, space, radius, type as t, dot} from '../../theme/tokens.ts';

export interface CompassChatBlocksProps {
  blocks?: CompassUiBlock[];
  payload?: CompassAskPayload | null;
  /** Opens the existing PlanPicker flow for a real place (user confirms the write). */
  onAddPlaceToPlan?: (place: CompassUiPlace) => void;
}

export function CompassChatBlocks({ blocks, payload, onAddPlaceToPlan }: CompassChatBlocksProps) {
  const hasBlocks = (blocks ?? []).length > 0;
  const hasItinerary = payload?.type === 'itinerary' && (payload.days ?? []).length > 0;
  if (!hasBlocks && !hasItinerary) return null;

  return (
    <View style={s.wrap}>
      {(blocks ?? []).map((b, i) => (
        <BlockRenderer key={`${b.type}_${i}`} block={b} onAddPlaceToPlan={onAddPlaceToPlan} />
      ))}
      {hasItinerary ? <ItineraryBlock payload={payload!} /> : null}
    </View>
  );
}

function BlockRenderer({ block, onAddPlaceToPlan }: {
  block: CompassUiBlock;
  onAddPlaceToPlan?: (place: CompassUiPlace) => void;
}) {
  switch (block.type) {
    case 'place_cards':
      return (
        <View style={s.stack}>
          {block.places.map((p) => (
            <PlaceBlockCard key={p.id} place={p} onAddToPlan={onAddPlaceToPlan} />
          ))}
        </View>
      );
    case 'event_cards':
      return <EventCardsBlock events={block.events} />;
    case 'person_cards':
      return (
        <View style={s.stack}>
          {block.people.map((p) => <PersonBlockCard key={p.handle} person={p} />)}
        </View>
      );
    case 'map':
      return <MapBlock places={block.places} />;
    case 'comparison':
      return <ComparisonBlock columns={block.columns} rows={block.rows} />;
    default:
      return null;
  }
}

// ── Navigation targets (all real screens) ─────────────────────────────────────

function usePlaceNavigation() {
  const router = useRouter();
  return (place: CompassUiPlace) => {
    // Fire-and-forget "viewed" outcome — the user actually opened this card.
    // Prefer the server-issued recommendation token (exact attribution);
    // fall back to the bare item id on older payloads.
    reportCompassViewed(place.recommendationToken ?? null, place.id);
    if (place.lat != null && place.lng != null) {
      router.push({
        pathname: '/map',
        params: {
          // §35: this session originates from Compass.
          entry: 'compass',
          lat: String(place.lat),
          lng: String(place.lng),
          focusId: place.id,
          title: place.name,
          ...(place.category ? { category: place.category } : {}),
        },
      } as any);
    } else {
      router.push({ pathname: '/search', params: { q: place.name, type: 'places' } } as any);
    }
  };
}

// ── Confidence pill (Phase 8) ─────────────────────────────────────────────────
//
// Surfaces the server's data-confidence label honestly:
//   verified_live → green "Live", community_reported → "Community",
//   historical → "Historical", ai_inference → "AI".

const CONFIDENCE_STYLE: Record<string, { text: string; fg: string; bg: string }> = {
  verified_live:      { text: 'Live',       fg: '#047857', bg: '#04785716' },
  community_reported: { text: 'Community',  fg: '#1D4ED8', bg: '#1D4ED816' },
  historical:         { text: 'Historical', fg: '#6B7280', bg: '#6B728016' },
  ai_inference:       { text: 'AI',         fg: '#7C3AED', bg: '#7C3AED16' },
};

/** Plain-language explanation for each source class (tap-to-explain sheet). */
const CONFIDENCE_EXPLANATION: Record<string, string> = {
  verified_live:      'This info was checked against a live source, so it reflects what\u2019s happening right now.',
  community_reported: 'This info comes from reports by travelers in the community. It\u2019s usually reliable, but hasn\u2019t been verified live.',
  historical:         'This info is based on past records. Things like hours or availability may have changed since it was last checked.',
  ai_inference:       'This info was inferred by AI from general knowledge, not confirmed by a live source or the community. Double-check before relying on it.',
};

/** "Checked Jul 21, 10:30 AM" — falls back to null when the date is invalid. */
function formatCheckedAt(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return `Checked ${d.toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    })}`;
  } catch {
    return `Checked ${d.toISOString()}`;
  }
}

function ConfidencePill({ confidence, testID }: {
  confidence?: CompassUiConfidence | null;
  testID: string;
}) {
  const [open, setOpen] = useState(false);
  if (!confidence) return null;
  const c = CONFIDENCE_STYLE[confidence.sourceClass];
  if (!c) return null;
  const checked = formatCheckedAt(confidence.checkedAt);
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={`Data confidence: ${confidence.label}. Tap to learn what this means.`}
        testID={testID}
      >
        <Text style={[s.confidencePill, { color: c.fg, backgroundColor: c.bg }]}>
          {c.text}
        </Text>
      </Pressable>
      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable
          style={s.confidenceBackdrop}
          onPress={() => setOpen(false)}
          testID={`${testID}-sheet-backdrop`}
        >
          <View style={s.confidenceSheet} testID={`${testID}-sheet`}>
            <View style={s.confidenceSheetHead}>
              <Text style={[s.confidencePill, { color: c.fg, backgroundColor: c.bg }]}>
                {c.text}
              </Text>
              <Text style={s.confidenceSheetTitle} numberOfLines={2}>
                {confidence.label}
              </Text>
            </View>
            <Text style={s.confidenceSheetBody}>
              {CONFIDENCE_EXPLANATION[confidence.sourceClass]}
            </Text>
            {confidence.dataNote ? (
              <Text style={s.confidenceSheetNote} testID={`${testID}-sheet-note`}>
                {confidence.dataNote}
              </Text>
            ) : null}
            {checked ? (
              <Text style={s.confidenceSheetChecked} testID={`${testID}-sheet-checked`}>
                {checked}
              </Text>
            ) : null}
            <Pressable
              style={({ pressed }) => [s.confidenceSheetBtn, pressed && s.pressed]}
              onPress={() => setOpen(false)}
              accessibilityRole="button"
              accessibilityLabel="Close data confidence explanation"
              testID={`${testID}-sheet-close`}
            >
              <Text style={s.confidenceSheetBtnText}>Got it</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

// ── Place ─────────────────────────────────────────────────────────────────────

function PlaceBlockCard({ place, onAddToPlan }: {
  place: CompassUiPlace;
  onAddToPlan?: (place: CompassUiPlace) => void;
}) {
  const openPlace = usePlaceNavigation();
  const [whyOpen, setWhyOpen] = useState(false);
  // The AI chat tab stays mounted across navigation (it's a persistent tab,
  // not a stack screen), so tapping into a place and coming back would
  // otherwise leave this sheet's local state open — a "ghost sheet" that
  // reappears without the trigger being pressed again. Close on blur.
  useFocusEffect(useCallback(() => () => setWhyOpen(false), []));
  // Track hero image load errors so we can fall back to the accent strip
  const [imageError, setImageError] = useState(false);
  const placeFallback = getPlaceCategoryFallback(place.category ?? '');

  // Build candidates with real source metadata so isRepresentation is correct.
  const _compassCandidates: HeaderCandidate[] = [];
  if (place.headerImageUrl) {
    _compassCandidates.push({
      url: place.headerImageUrl,
      source: ((place.headerImageSource as HeaderCandidate['source']) ?? 'provider'),
    });
  }
  const resolvedCompass = resolveHeaderImage(_compassCandidates, {
    entityType: 'place',
    category: place.category ?? undefined,
    fallbackUrlFor: fallbackUriFor,
  });
  const resolvedUrl = resolvedCompass?.url ?? null;
  const hasImage = Boolean(resolvedUrl) && !imageError;

  return (
    <>
      <Pressable
        style={({ pressed }) => [s.card, pressed && s.pressed]}
        onPress={() => openPlace(place)}
        accessibilityRole="button"
        accessibilityLabel={`View ${place.name}`}
        testID={`compass-block-place-${place.id}`}
      >
        {/* Accent strip (hidden when a hero image is shown, to avoid visual noise) */}
        {!hasImage ? (
          <View
            style={[s.strip, { backgroundColor: placeFallback.color }]}
            testID={`compass-block-place-strip-${place.id}`}
          />
        ) : null}
        <View style={s.cardBody}>
          {/* Hero image — rendered when the resolver returns a URL */}
          {hasImage ? (
            <Image
              source={{ uri: resolvedUrl! }}
              style={s.placeHeroImage}
              resizeMode="cover"
              accessibilityLabel={place.name}
              testID={`compass-block-place-image-${place.id}`}
              onError={() => setImageError(true)}
            />
          ) : null}
          {/* AI-generated representation disclosure — shown below hero when source=ai_generated */}
          {resolvedCompass?.isRepresentation && !imageError && hasImage && (
            <AiRepresentationLabel
              style={s.aiLabel}
              testID={`compass-block-place-ai-label-${place.id}`}
            />
          )}
          <View style={s.titleRow}>
            <Text style={s.cardTitle} numberOfLines={1}>{place.name}</Text>
            <ChevronRight size={14} color={color.faint} />
          </View>
          <View style={s.metaRow}>
            {place.category ? <Text style={s.metaChip}>{place.category}</Text> : null}
            <ConfidencePill confidence={place.confidence} testID={`compass-confidence-${place.id}`} />
            {place.openNow != null ? (
              <Text style={[s.confidencePill, place.openNow
                ? { color: '#047857', backgroundColor: '#04785716' }
                : { color: '#B91C1C', backgroundColor: '#B91C1C16' }]}
                testID={`compass-open-now-${place.id}`}
              >
                {place.openNow ? 'Open now' : 'Closed now'}
              </Text>
            ) : null}
            {place.rating != null ? (
              <View style={s.inlineMeta}>
                <Star size={10} color="#F59E0B" fill="#F59E0B" />
                <Text style={s.metaText}>{place.rating.toFixed(1)}</Text>
              </View>
            ) : null}
            {(place.neighborhood || place.city) ? (
              <View style={s.inlineMeta}>
                <MapPin size={10} color={color.mute} />
                <Text style={s.metaText} numberOfLines={1}>{place.neighborhood ?? place.city}</Text>
              </View>
            ) : null}
          </View>
          {place.blurb ? <Text style={s.blurb} numberOfLines={2}>{place.blurb}</Text> : null}
          <View style={s.cardActions}>
            {onAddToPlan ? (
              <Pressable
                style={({ pressed }) => [s.planBtn, pressed && s.pressed]}
                onPress={() => onAddToPlan(place)}
                hitSlop={6}
                accessibilityLabel={`Add ${place.name} to plan`}
                testID={`compass-block-place-plan-${place.id}`}
              >
                <Plus size={12} color={color.signal} />
                <Text style={s.planBtnText}>Plan</Text>
              </Pressable>
            ) : null}
            {/* Honest coordinates only — no name-only fallback. Mirrors PlaceCard/PlaceDetailSheet. */}
            {place.lat != null && place.lng != null ? (
              <Pressable
                style={({ pressed }) => [s.planBtn, pressed && s.pressed]}
                onPress={() => {
                  const url = `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}`;
                  Linking.openURL(url).catch(() => {});
                }}
                hitSlop={6}
                accessibilityLabel={`Directions to ${place.name}`}
                testID={`compass-block-place-directions-${place.id}`}
              >
                <Navigation size={12} color={color.deep} />
                <Text style={[s.planBtnText, { color: color.deep }]}>Directions</Text>
              </Pressable>
            ) : null}
            {place.recommendationToken ? (
              <Pressable
                style={({ pressed }) => [s.whyBtn, pressed && s.pressed]}
                onPress={() => setWhyOpen(true)}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={`Why am I seeing ${place.name}?`}
                testID={`compass-block-place-why-${place.id}`}
              >
                <Sparkles size={12} color={color.mute} />
                <Text style={s.whyBtnText}>Why this?</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </Pressable>
      {place.recommendationToken ? (
        <CompassWhySheet
          visible={whyOpen}
          recommendationId={place.recommendationToken}
          onClose={() => setWhyOpen(false)}
        />
      ) : null}
    </>
  );
}

// ── Event ─────────────────────────────────────────────────────────────────────

function EventBlockCard({ event }: { event: CompassUiEvent }) {
  const router = useRouter();
  const [whyOpen, setWhyOpen] = useState(false);
  useFocusEffect(useCallback(() => () => setWhyOpen(false), []));
  return (
    <>
      <Pressable
        style={({ pressed }) => [s.card, pressed && s.pressed]}
        onPress={() => {
          reportCompassViewed(event.recommendationToken ?? null, event.id);
          router.push(`/event/${event.id}` as any);
        }}
        accessibilityRole="button"
        accessibilityLabel={`View event ${event.title}`}
        testID={`compass-block-event-${event.id}`}
      >
        <View style={[s.strip, { backgroundColor: '#B45309' }]} />
        <View style={s.cardBody}>
          <View style={s.titleRow}>
            <Text style={s.cardTitle} numberOfLines={1}>{event.title}</Text>
            <ChevronRight size={14} color={color.faint} />
          </View>
          <View style={s.metaRow}>
            <ConfidencePill confidence={event.confidence} testID={`compass-confidence-${event.id}`} />
            <View style={s.inlineMeta}>
              <CalendarClock size={10} color={color.mute} />
              <Text style={s.metaText}>{formatCompassEventChip(event.startsAt)}</Text>
            </View>
            {event.city ? (
              <View style={s.inlineMeta}>
                <MapPin size={10} color={color.mute} />
                <Text style={s.metaText} numberOfLines={1}>{event.city}</Text>
              </View>
            ) : null}
          </View>
          {event.description ? <Text style={s.blurb} numberOfLines={2}>{event.description}</Text> : null}
          <View style={s.cardActions}>
            {event.lat != null && event.lng != null ? (
              <Pressable
                style={({ pressed }) => [s.planBtn, pressed && s.pressed]}
                onPress={() => {
                  reportCompassViewed(event.recommendationToken ?? null, event.id);
                  router.push({
                    pathname: '/map',
                    params: {
                      // §35: this session originates from Compass.
                      entry: 'compass',
                      lat: String(event.lat),
                      lng: String(event.lng),
                      focusId: event.id,
                      title: event.title,
                      ...(event.category ? { category: event.category } : {}),
                    },
                  } as any);
                }}
                hitSlop={6}
                accessibilityLabel={`View ${event.title} on map`}
                testID={`compass-block-event-map-${event.id}`}
              >
                <MapPin size={12} color={color.signal} />
                <Text style={s.planBtnText}>Map</Text>
              </Pressable>
            ) : null}
            {event.recommendationToken ? (
              <Pressable
                style={({ pressed }) => [s.whyBtn, pressed && s.pressed]}
                onPress={() => setWhyOpen(true)}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={`Why am I seeing ${event.title}?`}
                testID={`compass-block-event-why-${event.id}`}
              >
                <Sparkles size={12} color={color.mute} />
                <Text style={s.whyBtnText}>Why this?</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </Pressable>
      {event.recommendationToken ? (
        <CompassWhySheet
          visible={whyOpen}
          recommendationId={event.recommendationToken}
          onClose={() => setWhyOpen(false)}
        />
      ) : null}
    </>
  );
}

// ── Event cards block (mini-map preview + cards) ──────────────────────────────

function EventCardsBlock({ events }: { events: CompassUiEvent[] }) {
  const router = useRouter();
  const coordEvents = events.filter((e) => e.lat != null && e.lng != null);
  const points: CompassMiniMapPoint[] = coordEvents.map((e) => ({
    id: e.id, label: e.title, lat: e.lat!, lng: e.lng!,
  }));
  const first = coordEvents[0];
  return (
    <View style={s.stack}>
      {points.length > 0 && first ? (
        <CompassMiniMap
          points={points}
          onPress={() => {
            reportCompassViewed(first.recommendationToken ?? null, first.id);
            router.push({
              pathname: '/map',
              params: {
                // §35: this session originates from Compass.
                entry: 'compass',
                lat: String(first.lat),
                lng: String(first.lng),
                focusId: first.id,
                title: first.title,
                ...(first.category ? { category: first.category } : {}),
              },
            } as any);
          }}
          testID="compass-block-event-map-preview"
        />
      ) : null}
      {events.map((e) => <EventBlockCard key={e.id} event={e} />)}
    </View>
  );
}

// ── Person ────────────────────────────────────────────────────────────────────

function PersonBlockCard({ person }: { person: CompassUiPerson }) {
  const router = useRouter();
  return (
    <Pressable
      style={({ pressed }) => [s.card, pressed && s.pressed]}
      onPress={() => router.push(`/u/${encodeURIComponent(person.handle)}` as any)}
      accessibilityRole="button"
      accessibilityLabel={`View profile @${person.handle}`}
      testID={`compass-block-person-${person.handle}`}
    >
      <View style={[s.strip, { backgroundColor: color.deep }]} />
      <View style={s.cardBody}>
        <View style={s.titleRow}>
          <Text style={s.cardTitle} numberOfLines={1}>@{person.handle}</Text>
          <ChevronRight size={14} color={color.faint} />
        </View>
        {person.circleName ? (
          <View style={s.inlineMeta}>
            <Users size={10} color={color.mute} />
            <Text style={s.metaText} numberOfLines={1}>{person.circleName}</Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

// ── Map ───────────────────────────────────────────────────────────────────────

function placesToPoints(places: CompassUiPlace[]): CompassMiniMapPoint[] {
  return places
    .filter((p) => p.lat != null && p.lng != null)
    .map((p) => ({ id: p.id, label: p.name, lat: p.lat!, lng: p.lng! }));
}

function MapBlock({ places }: { places: CompassUiPlace[] }) {
  const openPlace = usePlaceNavigation();
  const points = placesToPoints(places);
  const firstWithCoords = places.find((p) => p.lat != null && p.lng != null);
  return (
    <View style={s.mapBlock}>
      <View style={s.mapHead}>
        <MapIcon size={12} color={color.signal} />
        <Text style={s.mapHeadText}>ON THE MAP</Text>
      </View>
      {points.length > 0 ? (
        <CompassMiniMap
          points={points}
          onPress={firstWithCoords ? () => openPlace(firstWithCoords) : undefined}
          testID="compass-block-map-preview"
        />
      ) : null}
      {places.map((p) => (
        <Pressable
          key={p.id}
          style={({ pressed }) => [s.mapRow, pressed && s.pressed]}
          onPress={() => openPlace(p)}
          accessibilityRole="button"
          accessibilityLabel={`Show ${p.name} on the map`}
          testID={`compass-block-map-${p.id}`}
        >
          <MapPin size={12} color={color.signal} />
          <Text style={s.mapRowText} numberOfLines={1}>{p.name}</Text>
          {p.city ? <Text style={s.metaText}>{p.city}</Text> : null}
          <ChevronRight size={13} color={color.faint} />
        </Pressable>
      ))}
    </View>
  );
}

// ── Comparison ────────────────────────────────────────────────────────────────

function ComparisonBlock({ columns, rows }: { columns: string[]; rows: CompassComparisonRow[] }) {
  const router = useRouter();
  const openPlace = usePlaceNavigation();

  const openRow = (row: CompassComparisonRow) => {
    if (row.kind === 'event') {
      reportCompassViewed(row.event?.recommendationToken ?? null, row.id);
      router.push(`/event/${row.id}` as any);
    } else if (row.place) {
      openPlace(row.place);
    } else {
      reportCompassViewed(null, row.id);
      router.push({ pathname: '/search', params: { q: row.label, type: 'places' } } as any);
    }
  };

  // Inline distance context: when at least two compared entities carry real
  // coordinates, show them on a mini-map with the pairwise distance delta.
  // Rows of either kind count — places and events (hydrated venue coords).
  const rowCoords = (r: CompassComparisonRow): { lat: number; lng: number } | null => {
    const src = r.kind === 'event' ? r.event : r.place;
    return src?.lat != null && src?.lng != null ? { lat: src.lat, lng: src.lng } : null;
  };
  const coordRows = rows.filter((r) => rowCoords(r) != null);
  const points: CompassMiniMapPoint[] = coordRows.map((r) => {
    const c = rowCoords(r)!;
    return { id: r.id, label: r.label, lat: c.lat, lng: c.lng };
  });
  const deltas: string[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[0], b = points[i];
    deltas.push(`${a.label} ↔ ${b.label} · ${formatDistanceKm(haversineKm(a.lat, a.lng, b.lat, b.lng))}`);
  }

  return (
    <View style={s.table}>
      {points.length >= 2 ? (
        <View style={s.compareMapWrap}>
          <CompassMiniMap
            points={points}
            height={140}
            onPress={coordRows[0] ? () => openRow(coordRows[0]) : undefined}
            testID="compass-block-compare-map"
          />
          {deltas.map((d, i) => (
            <Text key={i} style={s.compareDelta} testID={`compass-block-compare-delta-${i}`}>
              {d}
            </Text>
          ))}
        </View>
      ) : null}
      <View style={[s.tableRow, s.tableHead]}>
        <Text style={[s.tableHeadCell, s.tableLabelCell]} numberOfLines={1}> </Text>
        {columns.map((c) => (
          <Text key={c} style={[s.tableHeadCell, s.tableCell]} numberOfLines={1}>{c}</Text>
        ))}
      </View>
      {rows.map((r) => (
        <Pressable
          key={`${r.kind}_${r.id}`}
          style={({ pressed }) => [s.tableRow, pressed && s.pressed]}
          onPress={() => openRow(r)}
          accessibilityRole="button"
          accessibilityLabel={`Open ${r.label}`}
          testID={`compass-block-compare-${r.id}`}
        >
          <Text style={[s.tableLabelCell, s.tableLabelText]} numberOfLines={2}>{r.label}</Text>
          {columns.map((_, ci) => (
            <Text key={ci} style={[s.tableCell, s.tableCellText]} numberOfLines={2}>
              {r.values[ci] ?? '—'}
            </Text>
          ))}
        </Pressable>
      ))}
    </View>
  );
}

// ── Itinerary / timeline ──────────────────────────────────────────────────────

function ItineraryBlock({ payload }: { payload: CompassAskPayload }) {
  return (
    <View style={s.itinerary} testID="compass-block-itinerary">
      {payload.destination ? (
        <Text style={s.itineraryDest} numberOfLines={1}>{payload.destination}</Text>
      ) : null}
      {(payload.days ?? []).map((day, di) => (
        <View key={`${day.label}_${di}`} style={s.dayRow}>
          <View style={s.dayRail}>
            <View style={s.dayDot} />
            {di < (payload.days ?? []).length - 1 ? <View style={s.dayLine} /> : null}
          </View>
          <View style={s.dayBody}>
            <Text style={s.dayLabel}>{day.label}</Text>
            {(day.highlights ?? []).map((h, hi) => (
              <Text key={hi} style={s.dayHighlight}>• {h}</Text>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  wrap:       { gap: space.sm, marginTop: space.sm },
  stack:      { gap: space.sm },
  pressed:    { opacity: 0.7 },

  card:       { flexDirection: 'row', backgroundColor: color.paper, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, overflow: 'hidden' },
  strip:      { width: 3 },
  cardBody:   { flex: 1, padding: space.md, gap: 4 },
  placeHeroImage: { width: '100%' as const, height: 100, borderRadius: radius.sm, marginBottom: 2 },
  aiLabel: { marginBottom: 2 },
  titleRow:   { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  cardTitle:  { ...t.bodyStrong, color: color.ink, flex: 1, fontSize: 13 },
  metaRow:    { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  metaChip:   { ...t.stamp, fontSize: 10, color: color.signal, backgroundColor: color.signal + '16', paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: radius.pill, textTransform: 'capitalize' },
  confidencePill: { ...t.stamp, fontSize: 9, fontWeight: '700', paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: radius.pill, overflow: 'hidden' },
  confidenceBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  confidenceSheet: { backgroundColor: color.paper, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: 36, gap: space.sm },
  confidenceSheetHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  confidenceSheetTitle: { ...t.bodyStrong, color: color.ink, fontSize: 15, flex: 1 },
  confidenceSheetBody: { ...t.body, color: color.ink, fontSize: 13, lineHeight: 19 },
  confidenceSheetNote: { ...t.small, fontSize: 12, color: '#B45309', lineHeight: 17 },
  confidenceSheetChecked: { ...t.small, fontSize: 11, color: color.mute },
  confidenceSheetBtn: { backgroundColor: color.signal, borderRadius: radius.md, paddingVertical: 12, alignItems: 'center', marginTop: space.sm },
  confidenceSheetBtnText: { ...t.bodyStrong, color: '#fff', fontSize: 14 },
  inlineMeta: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  metaText:   { ...t.stamp, fontSize: 10, color: color.mute },
  blurb:      { ...t.small, fontSize: 11, color: color.mute, lineHeight: 15 },
  cardActions:{ flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap', marginTop: 2 },
  planBtn:    { flexDirection: 'row', alignItems: 'center', gap: 3, alignSelf: 'flex-start', backgroundColor: color.haze, paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.sm },
  planBtnText:{ ...t.stamp, fontSize: 10, fontWeight: '700', color: color.signal },
  whyBtn:     { flexDirection: 'row', alignItems: 'center', gap: 3, alignSelf: 'flex-start', backgroundColor: color.haze, paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.sm },
  whyBtnText: { ...t.stamp, fontSize: 10, fontWeight: '600', color: color.mute },

  mapBlock:   { backgroundColor: color.paper, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.sm, gap: 2 },
  mapHead:    { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.xs, paddingBottom: 4 },
  mapHeadText:{ ...t.stamp, fontFamily: 'Courier', fontSize: 9, color: color.signal, letterSpacing: 1 },
  mapRow:     { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm, paddingHorizontal: space.xs, borderTopWidth: 1, borderTopColor: color.haze },
  mapRowText: { ...t.small, fontWeight: '600', color: color.ink, flex: 1 },

  compareMapWrap: { padding: space.sm, gap: 4 },
  compareDelta: { ...t.stamp, fontSize: 10, color: color.mute, paddingHorizontal: space.xs },

  table:        { backgroundColor: color.paper, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, overflow: 'hidden' },
  tableRow:     { flexDirection: 'row', alignItems: 'center', paddingVertical: space.sm, paddingHorizontal: space.sm, borderTopWidth: 1, borderTopColor: color.haze },
  tableHead:    { borderTopWidth: 0, backgroundColor: color.haze + '55' },
  tableHeadCell:{ ...t.stamp, fontSize: 9, fontWeight: '700', color: color.mute, textTransform: 'uppercase', letterSpacing: 0.4 },
  tableLabelCell:{ flex: 1.2, paddingRight: space.xs },
  tableCell:    { flex: 1, paddingRight: space.xs },
  tableLabelText:{ ...t.small, fontSize: 11, fontWeight: '700', color: color.ink },
  tableCellText:{ ...t.small, fontSize: 11, color: color.mute },

  itinerary:    { backgroundColor: color.paper, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md, gap: 2 },
  itineraryDest:{ ...t.stamp, fontFamily: 'Courier', fontSize: 10, color: color.signal, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4 },
  dayRow:       { flexDirection: 'row', gap: space.sm },
  dayRail:      { alignItems: 'center', width: 12 },
  dayDot:       { width: dot.s8, height: dot.s8, borderRadius: dot.s8 / 2, backgroundColor: color.signal, marginTop: 4 },
  dayLine:      { flex: 1, width: 2, backgroundColor: color.haze, marginTop: 2 },
  dayBody:      { flex: 1, paddingBottom: space.sm },
  dayLabel:     { ...t.small, fontWeight: '700', color: color.ink },
  dayHighlight: { ...t.small, fontSize: 11, color: color.mute, lineHeight: 16 },
});
