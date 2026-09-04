/**
 * AskCompassBar — NL search bar anchored above the bottom safe area on the
 * full-screen map.  Calls fetchCompassRecommendations with the user's query,
 * maps returned CompassRecommendation[] to MapEntity[], and hands results up
 * via onResults so the map can filter its visible markers.
 *
 * Prompt chips appear when the input is empty (idle state).
 * Keyboard-aware via KeyboardAvoidingView so the bar lifts above the keyboard
 * without resizing the map itself.
 */
import React, { useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Animated,
} from 'react-native';
import { Compass, Send, X } from 'lucide-react-native';
import { color, space, radius, type as t, avatar } from '../../theme/tokens.ts';
import {
  fetchCompassRecommendations,
  type CompassRecommendation,
} from '../../services/compass.ts';
import type { MapEntity } from '../../types/mapTypes.ts';
import { mapObjectToEntity } from '../../types/mapTypes.ts';
import { projectCompassResult } from '../../features/map/projection/clientProjection.ts';
import {
  cellFor,
  clearActiveDecision,
  currentDecisionId,
  emitMapEvent,
} from '../../features/map/telemetry/mapTelemetry.ts';
import { useOptionalMapStore } from '../../stores/mapStore.tsx';
import { intentToRankingContext } from '../../features/map/intent/intentModel.ts';

// ── Prompt chips ──────────────────────────────────────────────────────────────

const PROMPT_CHIPS = [
  'Live events near me',
  'Find a Buddy',
  'Where are my friends?',
  'Hidden gems nearby',
  'Trips this weekend',
];


/**
 * Map a CompassRecommendation to a MapEntity, THROUGH THE PROJECTION.
 *
 * This used to hand the raw `CompassRecommendation` straight through as
 * `entity.payload`, which gave the map cards a third payload shape to guess at —
 * and two of their reads (`buddy.categories.slice`, `trip.visibility.replace`)
 * threw outright on it. Compass results now go through `projectCompassResult`
 * like every other producer, so a card sees exactly one contract.
 *
 * Returns null for unsupported types and for results with no real coordinates.
 * We intentionally do NOT fall back to the user's current location: placing
 * un-geocoded results at the user's dot causes the camera "fly-to" in
 * map/index.tsx to target where the user already is, making the camera appear
 * not to move after a city search. The caller's geocodeAndFly moves the camera
 * to the queried location independently.
 */
function toMapEntity(rec: CompassRecommendation): MapEntity | null {
  const obj = projectCompassResult(rec);
  if (!obj) return null;
  return mapObjectToEntity(obj);
}

// ── Component ─────────────────────────────────────────────────────────────────

export interface AskCompassBarProps {
  /** Called with the filtered MapEntity[] and the query string when a search completes. */
  onResults: (entities: MapEntity[], query: string) => void;
  /** Called when the user dismisses an active filter. */
  onClear: () => void;
  /** Active city name — passed to the Compass API. */
  city: string;
  /** User's current latitude — used for result coordinate fallback. */
  userLat?: number | null;
  /** User's current longitude — used for result coordinate fallback. */
  userLng?: number | null;
  /** Bottom inset so the bar clears the safe area. */
  bottomInset?: number;
}

export function AskCompassBar({
  onResults,
  onClear,
  city,
  userLat,
  userLng,
  bottomInset = 0,
}: AskCompassBarProps) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const inputRef = useRef<TextInput>(null);

  // §35 telemetry context. Optional store: this bar renders inside the map
  // screen's MapStoreProvider, but the hook fails soft so a stray mount (or a
  // test) can never crash on a missing provider.
  const mapStore = useOptionalMapStore();

  /**
   * §35 `compass_requested` — the event that MINTS the decisionId every later
   * outcome (`compass_option_selected` → `recommendation_accepted` →
   * `route_started` → `contribution_submitted`) is joined on.
   *
   * Before minting a new one, an unresolved previous decision is closed out:
   * asking Compass a second question without acting on the first answer IS the
   * negative arm, and leaving the old id active would mis-attribute the NEXT
   * ask's outcomes to the PREVIOUS question. `clearActiveDecision()` exists for
   * exactly this.
   *
   * The query text is deliberately absent — §35 payloads carry an intent slug,
   * never free text, and a search string is a location by another route.
   */
  function emitCompassRequested(trigger: 'action_rail' | 'empty_state'): void {
    try {
      if (currentDecisionId() !== null) {
        emitMapEvent('recommendation_declined', {
          reason: 'unspecified',
          explicit: false,
        });
        clearActiveDecision();
      }
      const lat = typeof userLat === 'number' ? userLat : null;
      const lng = typeof userLng === 'number' ? userLng : null;
      const intentKind = mapStore?.intent?.kind;
      emitMapEvent('compass_requested', {
        trigger,
        mode: mapStore?.machine.mode ?? 'LIVE',
        contextCell: lat != null && lng != null ? cellFor(lat, lng) : null,
        ...(intentKind ? { intent: intentKind } : {}),
      });
    } catch {
      // Telemetry may never block, reorder or break the ask.
    }
  }

  async function submit(q: string, trigger: 'action_rail' | 'empty_state' = 'action_rail') {
    const trimmed = q.trim();
    if (!trimmed || loading) return;

    emitCompassRequested(trigger);

    setLoading(true);
    setErrorMsg(null);
    inputRef.current?.blur();

    // §13 TemporaryIntent addend (Table 9). intentToRankingContext is the ONE
    // blessed projection of the store's intent into ranking input: it routes
    // through activeIntent, so an EXPIRED intent projects to nulls and is not
    // sent — a stale mood can never reach the ranker from here. When a live
    // intent exists, its kind + sliders + horizon ride along so the map's
    // Compass results are ranked for what the user wants right now, and the
    // server can mark which picks "Match current intent".
    const intentCtx = intentToRankingContext(mapStore?.intent ?? null);

    const res = await fetchCompassRecommendations({
      q: trimmed,
      city: city || undefined,
      surface: 'map',
      limit: 30,
      ...(intentCtx.kind
        ? {
            intent: intentCtx.kind,
            intentEnergy: intentCtx.energy ?? undefined,
            intentNovelty: intentCtx.novelty ?? undefined,
            intentExpiresAt: intentCtx.expiresAt ?? undefined,
          }
        : {}),
    });

    setLoading(false);

    if (!res.ok || !res.data) {
      setErrorMsg("Couldn't reach Compass — check connection");
      // Leave existing markers unchanged (do NOT call onResults)
      return;
    }

    const recs = res.data.recommendations ?? [];
    const entities: MapEntity[] = recs
      .map((r) => toMapEntity(r))
      .filter((e): e is MapEntity => e !== null);

    // onResults([]) triggers carousel empty state — intentional for zero results.
    // Camera fly-to is handled by the parent (geocodeAndFly in map/index.tsx).
    onResults(entities, trimmed);
  }

  function handleChipPress(chip: string) {
    setQuery(chip);
    // Chips only appear in the idle/empty state — record that as the trigger
    // rather than flattening every ask into 'action_rail'.
    submit(chip, 'empty_state');
  }

  function handleClearError() {
    setErrorMsg(null);
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={0}
      pointerEvents="box-none"
    >
      <View style={[s.container, { paddingBottom: Math.max(bottomInset, space.md) }]}>
        {/* Error toast */}
        {errorMsg && !loading && (
          <View style={s.errorToast}>
            <Text style={s.errorText} numberOfLines={1}>{errorMsg}</Text>
            <Pressable onPress={handleClearError} hitSlop={8}>
              <X size={13} color={color.onInk} />
            </Pressable>
          </View>
        )}

        {/* Prompt chips — only shown when idle (no query typed) */}
        {!query && !loading && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.chipRow}
            pointerEvents="box-none"
            keyboardShouldPersistTaps="handled"
          >
            {PROMPT_CHIPS.map((chip) => (
              <Pressable key={chip} style={s.chip} onPress={() => handleChipPress(chip)}>
                <Text style={s.chipText}>{chip}</Text>
              </Pressable>
            ))}
          </ScrollView>
        )}

        {/* Input bar */}
        <View style={s.barRow}>
          {/* Compass icon */}
          <View style={s.iconWrap}>
            {loading ? (
              <ActivityIndicator size="small" color={color.onInk} />
            ) : (
              <Compass size={16} color={color.onInk} />
            )}
          </View>

          <TextInput
            ref={inputRef}
            style={s.input}
            value={query}
            onChangeText={setQuery}
            placeholder="Ask Compass…"
            placeholderTextColor="rgba(255,255,255,0.5)"
            onSubmitEditing={() => submit(query)}
            returnKeyType="search"
            maxLength={500}
            multiline={false}
            editable={!loading}
            selectionColor="#fff"
          />

          {/* Send / clear */}
          {query.length > 0 ? (
            <Pressable
              style={[s.sendBtn, loading && { opacity: 0.4 }]}
              onPress={() => submit(query)}
              disabled={loading}
              hitSlop={8}
            >
              <Send size={15} color={color.onInk} />
            </Pressable>
          ) : null}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

// Portava navy/teal brand palette:  deep = '#0A3D4A'  (teal-ink)
const BRAND_BG  = '#0A3D4A';   // deep navy
const CHIP_BG   = 'rgba(255,255,255,0.13)';
const CHIP_BORDER = 'rgba(255,255,255,0.22)';

const s = StyleSheet.create({
  container: {
    paddingHorizontal: space.md,
    gap: space.sm,
  },
  // Error toast
  errorToast: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(180,30,10,0.92)',
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: 9,
    gap: space.sm,
  },
  errorText: {
    ...t.small,
    color: '#fff',
    flex: 1,
    fontSize: 12,
  },
  // Chips row
  chipRow: {
    gap: space.sm,
    paddingHorizontal: 2,
  },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: CHIP_BG,
    borderWidth: 1,
    borderColor: CHIP_BORDER,
  },
  chipText: {
    ...t.small,
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  // Input bar
  barRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: BRAND_BG,
    borderRadius: radius.pill,
    paddingLeft: space.sm,
    paddingRight: space.sm,
    paddingVertical: Platform.OS === 'ios' ? 10 : 6,
    gap: space.sm,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 8,
  },
  iconWrap: {
    width: avatar.s28, height: avatar.s28,
    borderRadius: avatar.s28 / 2,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    flex: 1,
    ...t.body,
    color: '#fff',
    fontSize: 14,
    paddingVertical: 0,
  },
  sendBtn: {
    width: avatar.s30, height: avatar.s30,
    borderRadius: avatar.s30 / 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
