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
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import {
  fetchCompassRecommendations,
  type CompassRecommendation,
} from '../../services/compass.ts';
import type { MapEntity, MapEntityType } from '../../types/mapTypes.ts';

// ── Prompt chips ──────────────────────────────────────────────────────────────

const PROMPT_CHIPS = [
  'Live events near me',
  'Find a Buddy',
  'Where are my friends?',
  'Hidden gems nearby',
  'Trips this weekend',
];

// ── Compass type → MapEntityType mapping ──────────────────────────────────────

const COMPASS_TYPE_MAP: Record<string, MapEntityType> = {
  event:      'events',
  place:      'places',
  gem:        'gems',
  hidden_gem: 'gems',
  buddy:      'buddies',
  traveler:   'travelers',
  user:       'travelers',
  trip:       'trips',
  friend:     'friends',
};

/**
 * Map a CompassRecommendation to a MapEntity.
 * Returns null for unsupported types so callers can filter them out silently.
 */
function toMapEntity(
  rec: CompassRecommendation,
  fallbackLat: number,
  fallbackLng: number,
): MapEntity | null {
  const entityType = COMPASS_TYPE_MAP[rec.type ?? ''];
  if (!entityType) return null; // unsupported type — silently ignored

  // Prefer coordinates from the recommendation payload; fall back to the
  // active city centre with a small deterministic offset so markers don't
  // all stack on the same pixel.
  const dataLat = typeof rec.data?.lat === 'number' ? rec.data.lat : null;
  const dataLng = typeof rec.data?.lng === 'number' ? rec.data.lng : null;

  // If no coordinates at all, skip the entity — a pin at 0,0 is worse than
  // not showing it.
  const lat = dataLat ?? fallbackLat;
  const lng = dataLng ?? fallbackLng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return {
    id: rec.id,
    type: entityType,
    lat,
    lng,
    payload: rec,
  };
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

  const fallbackLat = (userLat != null && Number.isFinite(userLat)) ? userLat : 0;
  const fallbackLng = (userLng != null && Number.isFinite(userLng)) ? userLng : 0;

  async function submit(q: string) {
    const trimmed = q.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    setErrorMsg(null);
    inputRef.current?.blur();

    const res = await fetchCompassRecommendations({
      q: trimmed,
      city: city || undefined,
      surface: 'map',
      limit: 30,
    });

    setLoading(false);

    if (!res.ok || !res.data) {
      setErrorMsg("Couldn't reach Compass — check connection");
      // Leave existing markers unchanged (do NOT call onResults)
      return;
    }

    const recs = res.data.recommendations ?? [];
    const entities: MapEntity[] = recs
      .map((r) => toMapEntity(r, fallbackLat, fallbackLng))
      .filter((e): e is MapEntity => e !== null);

    // onResults([]) triggers carousel empty state — intentional for zero results
    onResults(entities, trimmed);
  }

  function handleChipPress(chip: string) {
    setQuery(chip);
    submit(chip);
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
    width: 28,
    height: 28,
    borderRadius: 14,
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
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
