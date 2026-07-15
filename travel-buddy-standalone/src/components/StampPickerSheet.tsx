/**
 * StampPickerSheet — bottom sheet for choosing an optional passport stamp to
 * place on a postcard photo.
 *
 * Sections:
 *   "For this location" — universal stamps matching the tagged city/country
 *   "Your stamps"       — the user's earned stamps (approved artwork only)
 *
 * Stamps are never auto-applied; the user always picks explicitly. The list
 * comes from GET /postcards/stamp-overlay-options which already enforces
 * eligibility and privacy (own inventory only).
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, Modal, Pressable, StyleSheet, TextInput,
  ActivityIndicator, ScrollView, Image,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Search, Stamp } from 'lucide-react-native';
import { getStampOverlayOptions } from '../services/postcards';
import type { StampOverlayOption } from '../lib/stampOverlay';
import { ProceduralStamp } from './StampOverlayBadge';
import { color, space, radius, type as t } from '../theme/tokens';

interface Props {
  visible: boolean;
  onClose: () => void;
  onSelect: (option: StampOverlayOption) => void;
  /** Location tagged on the postcard — drives the suggested section. */
  city?: string | null;
  country?: string | null;
}

export function StampPickerSheet({ visible, onClose, onSelect, city, country }: Props) {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [suggested, setSuggested] = useState<StampOverlayOption[]>([]);
  const [earned, setEarned] = useState<StampOverlayOption[]>([]);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!visible) return;
    setQuery('');
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      const res = await getStampOverlayOptions({ city, country });
      if (cancelled) return;
      setLoading(false);
      if (!res.ok) {
        setLoadError(res.message);
        return;
      }
      setSuggested(Array.isArray(res.data.suggested) ? res.data.suggested : []);
      setEarned(Array.isArray(res.data.earned) ? res.data.earned : []);
    })();
    return () => { cancelled = true; };
  }, [visible, city, country]);

  const q = query.trim().toLowerCase();
  const matches = (o: StampOverlayOption) =>
    !q ||
    o.name.toLowerCase().includes(q) ||
    (o.city ?? '').toLowerCase().includes(q) ||
    (o.country ?? '').toLowerCase().includes(q);

  const shownSuggested = useMemo(() => suggested.filter(matches), [suggested, q]);
  const shownEarned = useMemo(() => earned.filter(matches), [earned, q]);
  const empty = !loading && !loadError && shownSuggested.length === 0 && shownEarned.length === 0;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={sp.backdropWrap}>
        <Pressable style={sp.backdrop} onPress={onClose} />
        <View style={[sp.panel, { paddingBottom: Math.max(insets.bottom, space.lg) }]}>
          <View style={sp.header}>
            <Text style={sp.title}>Add a stamp</Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <X size={20} color={color.ink} />
            </Pressable>
          </View>

          <View style={sp.searchRow}>
            <Search size={16} color={color.faint} />
            <TextInput
              style={sp.searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder="Search stamps"
              placeholderTextColor={color.faint}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          {loading && (
            <View style={sp.stateWrap}>
              <ActivityIndicator color={color.signal} />
            </View>
          )}

          {loadError && !loading && (
            <View style={sp.stateWrap}>
              <Text style={sp.stateText}>{loadError}</Text>
            </View>
          )}

          {empty && (
            <View style={sp.stateWrap}>
              <Stamp size={22} color={color.faint} />
              <Text style={sp.stateText}>
                {q ? 'No stamps match your search.' : 'No stamps available yet — earn stamps by traveling, or tag a city with a universal stamp.'}
              </Text>
            </View>
          )}

          {!loading && !loadError && !empty && (
            <ScrollView style={sp.list} keyboardShouldPersistTaps="handled">
              {shownSuggested.length > 0 && (
                <>
                  <Text style={sp.section}>FOR THIS LOCATION</Text>
                  {shownSuggested.map((o) => (
                    <OptionRow key={o.stampDefinitionId} option={o} onPress={() => onSelect(o)} />
                  ))}
                </>
              )}
              {shownEarned.length > 0 && (
                <>
                  <Text style={sp.section}>YOUR STAMPS</Text>
                  {shownEarned.map((o) => (
                    <OptionRow key={o.stampDefinitionId} option={o} onPress={() => onSelect(o)} />
                  ))}
                </>
              )}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

function OptionRow({ option, onPress }: { option: StampOverlayOption; onPress: () => void }) {
  const [artFailed, setArtFailed] = useState(false);
  const place = [option.city, option.country].filter(Boolean).join(', ');
  return (
    <Pressable style={sp.row} onPress={onPress}>
      <View style={sp.art}>
        {artFailed ? (
          <ProceduralStamp size={40} label={option.name} ink={color.deep} />
        ) : (
          <Image
            source={{ uri: option.artworkUrl }}
            style={sp.artImg}
            resizeMode="cover"
            onError={() => setArtFailed(true)}
          />
        )}
      </View>
      <View style={sp.rowBody}>
        <Text style={sp.rowName} numberOfLines={1}>{option.name}</Text>
        {place ? <Text style={sp.rowPlace} numberOfLines={1}>{place}</Text> : null}
      </View>
      {option.rarity ? (
        <Text style={sp.rarity}>{option.rarity.toUpperCase()}</Text>
      ) : null}
    </Pressable>
  );
}

const sp = StyleSheet.create({
  backdropWrap: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(17,17,15,0.45)' },
  panel: {
    backgroundColor: color.paper,
    borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
    maxHeight: '82%', minHeight: 320,
    paddingTop: space.md,
  },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg, paddingBottom: space.sm,
  },
  title: { ...t.heading, color: color.ink },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    marginHorizontal: space.lg, marginBottom: space.sm,
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.md,
    paddingHorizontal: space.md, height: 42,
  },
  searchInput: { ...t.body, color: color.ink, flex: 1, paddingVertical: 0 },
  stateWrap: { alignItems: 'center', gap: space.sm, paddingVertical: space.xxl, paddingHorizontal: space.xl },
  stateText: { ...t.small, color: color.mute, textAlign: 'center' },
  list: { paddingHorizontal: space.lg },
  section: {
    fontFamily: 'Courier', fontSize: 10, fontWeight: '700', letterSpacing: 1,
    color: color.mute, marginTop: space.md, marginBottom: space.xs,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingVertical: space.sm,
  },
  art: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: color.haze, overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center',
  },
  artImg: { width: 44, height: 44, borderRadius: 22 },
  rowBody: { flex: 1, minWidth: 0 },
  rowName: { ...t.bodyStrong, color: color.ink },
  rowPlace: { ...t.small, color: color.mute },
  rarity: {
    fontFamily: 'Courier', fontSize: 9, fontWeight: '700', letterSpacing: 0.8,
    color: color.deep, borderWidth: 1, borderColor: color.haze,
    borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2,
  },
});
