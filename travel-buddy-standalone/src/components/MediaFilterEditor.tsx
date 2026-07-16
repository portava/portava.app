/**
 * MediaFilterEditor — full-screen filter editor for photos and videos.
 *
 * Props:
 *   file         — { uri, mimeType, width?, height? }
 *   mediaType    — 'image' | 'video'
 *   initialFilterId   — pre-selected filter (default 'original')
 *   initialIntensity  — pre-set intensity 0–100 (default from filter preset)
 *   onApply      — called with { uri, filterId, filterIntensity, mimeType }
 *   onCancel     — close without applying
 *
 * Photos: tapping Apply resizes via renderFilteredImage and returns the new URI.
 * Videos: tapping Apply returns the original URI + filter metadata (CSS-only).
 */
import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  Image,
  Pressable,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Modal,
  Dimensions,
  Platform,
} from 'react-native';
import Slider from '@react-native-community/slider';
import { X, RotateCcw, PlayCircle, Check } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, space, radius, type as t, shadow } from '../theme/tokens';
import { mediaFilters, getMediaFilter, buildCssFilter } from '../lib/media/filters';
import { renderFilteredImage } from '../lib/media/renderFilteredImage';

const { width: SCREEN_W } = Dimensions.get('window');

export interface FilterApplyResult {
  uri: string;
  filterId: string;
  filterIntensity: number;
  mimeType: string;
  /** True if the photo was resized/processed; false for video (metadata only). */
  processed: boolean;
}

interface Props {
  file: { uri: string; mimeType?: string | null; width?: number | null; height?: number | null };
  mediaType: 'image' | 'video';
  initialFilterId?: string;
  initialIntensity?: number;
  onApply: (result: FilterApplyResult) => void;
  onCancel: () => void;
}

export function MediaFilterEditor({
  file,
  mediaType,
  initialFilterId = 'original',
  initialIntensity,
  onApply,
  onCancel,
}: Props) {
  const insets = useSafeAreaInsets();
  const initialFilter = getMediaFilter(initialFilterId);
  const [selectedId, setSelectedId] = useState(initialFilter.id);
  const [intensity, setIntensity] = useState<number>(
    initialIntensity ?? initialFilter.defaultIntensity,
  );
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const currentFilter = getMediaFilter(selectedId);
  const cssFilter = buildCssFilter(currentFilter, intensity);

  function handleFilterSelect(id: string) {
    setSelectedId(id);
    setApplyError(null);
    const f = getMediaFilter(id);
    setIntensity(f.defaultIntensity);
  }

  function handleReset() {
    setSelectedId('original');
    setIntensity(100);
    setApplyError(null);
  }

  const handleApply = useCallback(async () => {
    if (applying) return;
    setApplyError(null);
    setApplying(true);
    try {
      if (mediaType === 'video') {
        onApply({
          uri: file.uri,
          filterId: selectedId,
          filterIntensity: intensity,
          mimeType: file.mimeType ?? 'video/mp4',
          processed: false,
        });
        return;
      }

      const result = await renderFilteredImage({
        uri: file.uri,
        filterId: selectedId,
        intensity,
      });

      onApply({
        uri: result.uri,
        filterId: result.filterId,
        filterIntensity: result.filterIntensity,
        mimeType: result.mimeType,
        processed: true,
      });
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : 'Filter failed. You can post as Original.');
    } finally {
      setApplying(false);
    }
  }, [applying, mediaType, file, selectedId, intensity, onApply]);

  function handleApplyAsOriginal() {
    setApplyError(null);
    onApply({
      uri: file.uri,
      filterId: 'original',
      filterIntensity: 100,
      mimeType: file.mimeType ?? 'image/jpeg',
      processed: false,
    });
  }

  const isOriginal = selectedId === 'original';

  return (
    <Modal visible animationType="slide" statusBarTranslucent onRequestClose={onCancel}>
      <View style={[s.container, { paddingTop: insets.top }]}>
        {/* Header */}
        <View style={s.header}>
          <Pressable style={s.headerBtn} onPress={onCancel} hitSlop={8}>
            <X size={20} color={color.onInk} />
          </Pressable>
          <Text style={s.headerTitle}>Filters</Text>
          <Pressable
            style={[s.applyBtn, applying && s.applyBtnDisabled]}
            onPress={handleApply}
            disabled={applying}
          >
            {applying
              ? <ActivityIndicator size="small" color="#fff" />
              : <><Check size={15} color="#fff" /><Text style={s.applyBtnText}>Apply</Text></>}
          </Pressable>
        </View>

        {/* Preview */}
        <View style={s.preview}>
          <Image
            source={{ uri: file.uri }}
            style={[
              StyleSheet.absoluteFill,
              cssFilter !== 'none' && Platform.OS === 'web'
                ? { filter: cssFilter } as any
                : undefined,
            ]}
            resizeMode="contain"
          />
          {/* Native: CSS filter overlay using opacity-blended tinted view */}
          {cssFilter !== 'none' && Platform.OS !== 'web' && (
            <View style={s.nativeFilterOverlay} pointerEvents="none">
              <FilterOverlayNative filterId={selectedId} intensity={intensity} />
            </View>
          )}
          {mediaType === 'video' && (
            <View style={s.videoTag} pointerEvents="none">
              <PlayCircle size={28} color="rgba(255,255,255,0.85)" />
              <Text style={s.videoTagText}>Video filter preview</Text>
            </View>
          )}
          {applying && (
            <View style={s.bakingOverlay} pointerEvents="none">
              <ActivityIndicator size="large" color="#fff" />
              <Text style={s.bakingText}>Applying filter…</Text>
            </View>
          )}
        </View>

        {/* Error banner */}
        {applyError && (
          <View style={s.errorRow}>
            <Text style={s.errorText} numberOfLines={2}>{applyError}</Text>
            <Pressable onPress={handleApplyAsOriginal}>
              <Text style={s.errorAction}>Post as Original</Text>
            </Pressable>
          </View>
        )}

        {/* Intensity slider */}
        <View style={s.sliderRow}>
          <Text style={s.sliderLabel}>Intensity</Text>
          <Slider
            style={s.slider}
            minimumValue={0}
            maximumValue={100}
            step={1}
            value={intensity}
            onValueChange={setIntensity}
            minimumTrackTintColor={color.signal}
            maximumTrackTintColor={color.haze}
            thumbTintColor={color.onInk}
            disabled={isOriginal}
          />
          <Text style={s.sliderValue}>{Math.round(intensity)}</Text>
        </View>

        {/* Filter carousel */}
        <View style={s.carouselWrap}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.carousel}
          >
            {mediaFilters.map((f) => {
              const isSelected = f.id === selectedId;
              return (
                <Pressable
                  key={f.id}
                  style={[s.filterItem, isSelected && s.filterItemSelected]}
                  onPress={() => handleFilterSelect(f.id)}
                >
                  {/* Thumbnail with filter preview */}
                  <View style={s.thumb}>
                    <Image
                      source={{ uri: file.uri }}
                      style={[
                        s.thumbImage,
                        f.id !== 'original' && Platform.OS === 'web'
                          ? { filter: buildCssFilter(f, f.defaultIntensity) } as any
                          : undefined,
                      ]}
                      resizeMode="cover"
                    />
                    {f.id !== 'original' && Platform.OS !== 'web' && (
                      <View style={StyleSheet.absoluteFill} pointerEvents="none">
                        <FilterOverlayNative filterId={f.id} intensity={f.defaultIntensity} />
                      </View>
                    )}
                    {isSelected && (
                      <View style={s.thumbSelected} pointerEvents="none">
                        <Check size={16} color="#fff" />
                      </View>
                    )}
                  </View>
                  <Text
                    style={[s.filterName, isSelected && s.filterNameSelected]}
                    numberOfLines={1}
                  >
                    {f.name}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>

        {/* Reset button */}
        <View style={[s.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <Pressable
            style={[s.resetBtn, isOriginal && s.resetBtnDisabled]}
            onPress={handleReset}
            disabled={isOriginal}
          >
            <RotateCcw size={14} color={isOriginal ? color.faint : color.ink} />
            <Text style={[s.resetText, isOriginal && s.resetTextDisabled]}>Reset to Original</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

/**
 * Native-platform filter overlay. Approximates CSS filter effects using a
 * semi-transparent tinted overlay. Not pixel-perfect but gives a visible
 * preview of the filter direction without requiring canvas or extra packages.
 */
function FilterOverlayNative({ filterId, intensity }: { filterId: string; intensity: number }) {
  const filter = getMediaFilter(filterId);
  if (filter.id === 'original') return null;

  const t = Math.max(0, Math.min(100, intensity)) / 100;

  const OVERLAY_COLORS: Record<string, string> = {
    wanderlust:   `rgba(255,180,80,${(0.18 * t).toFixed(2)})`,
    golden_hour:  `rgba(255,160,40,${(0.25 * t).toFixed(2)})`,
    deep_ocean:   `rgba(30,100,200,${(0.22 * t).toFixed(2)})`,
    mist:         `rgba(220,215,205,${(0.3 * t).toFixed(2)})`,
    polaroid:     `rgba(255,240,200,${(0.12 * t).toFixed(2)})`,
    noir:         `rgba(0,0,0,${(0.0 * t).toFixed(2)})`,
    safari:       `rgba(180,140,60,${(0.2 * t).toFixed(2)})`,
    vivid:        `rgba(255,60,100,${(0.1 * t).toFixed(2)})`,
    sunset:       `rgba(255,100,30,${(0.22 * t).toFixed(2)})`,
    arctic:       `rgba(180,220,255,${(0.2 * t).toFixed(2)})`,
    velvet:       `rgba(30,0,40,${(0.3 * t).toFixed(2)})`,
  };

  const overlayColor = OVERLAY_COLORS[filterId] ?? `rgba(0,0,0,0)`;

  return (
    <View
      style={[StyleSheet.absoluteFill, { backgroundColor: overlayColor }]}
      pointerEvents="none"
    />
  );
}

const PREVIEW_H = SCREEN_W * 0.72;

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0B0B0A' },

  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: space.lg, paddingVertical: 10, gap: space.md,
  },
  headerBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  headerTitle: { ...t.heading, color: '#fff', flex: 1, textAlign: 'center' },
  applyBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: color.signal, borderRadius: radius.pill,
    paddingHorizontal: space.md, paddingVertical: 8,
  },
  applyBtnDisabled: { opacity: 0.5 },
  applyBtnText: { ...t.small, color: '#fff', fontWeight: '700' },

  preview: {
    width: '100%', height: PREVIEW_H,
    backgroundColor: '#000',
    overflow: 'hidden',
  },
  nativeFilterOverlay: { ...StyleSheet.absoluteFillObject },
  videoTag: {
    position: 'absolute', bottom: space.lg, left: 0, right: 0,
    alignItems: 'center', gap: 6,
  },
  videoTagText: {
    color: 'rgba(255,255,255,0.85)', fontSize: 12, fontWeight: '700',
    backgroundColor: 'rgba(0,0,0,0.45)', paddingHorizontal: 10, paddingVertical: 3,
    borderRadius: radius.sm,
  },
  bakingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center', justifyContent: 'center', gap: space.sm,
  },
  bakingText: { color: '#fff', fontWeight: '600', fontSize: 14 },

  errorRow: {
    backgroundColor: '#3D0F0A', paddingHorizontal: space.lg, paddingVertical: 10,
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
  },
  errorText: { ...t.small, color: '#FF9B85', flex: 1 },
  errorAction: { ...t.small, color: color.signal, fontWeight: '700', textDecorationLine: 'underline' },

  sliderRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: space.lg, paddingVertical: 8, gap: space.sm,
  },
  sliderLabel: { ...t.small, color: 'rgba(255,255,255,0.6)', width: 60 },
  slider: { flex: 1 },
  sliderValue: { ...t.small, color: 'rgba(255,255,255,0.7)', width: 28, textAlign: 'right', fontFamily: 'Courier', fontSize: 12 },

  carouselWrap: { paddingTop: 4 },
  carousel: { paddingHorizontal: space.lg, gap: space.sm, paddingBottom: 4 },

  filterItem: {
    alignItems: 'center', gap: 5,
    borderRadius: radius.sm,
    padding: 4,
    borderWidth: 2, borderColor: 'transparent',
  },
  filterItemSelected: { borderColor: color.signal },

  thumb: {
    width: 68, height: 68,
    borderRadius: radius.sm,
    overflow: 'hidden',
    backgroundColor: '#222',
  },
  thumbImage: { width: '100%', height: '100%' },
  thumbSelected: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255,77,46,0.35)',
    alignItems: 'center', justifyContent: 'center',
  },

  filterName: { ...t.small, color: 'rgba(255,255,255,0.6)', fontSize: 10, width: 68, textAlign: 'center' },
  filterNameSelected: { color: color.signal, fontWeight: '700' },

  footer: {
    paddingHorizontal: space.lg, paddingTop: space.sm, alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.1)',
  },
  resetBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: space.lg, paddingVertical: 10,
    borderRadius: radius.pill, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
  },
  resetBtnDisabled: { borderColor: 'rgba(255,255,255,0.08)' },
  resetText: { ...t.small, color: color.onInk, fontWeight: '700' },
  resetTextDisabled: { color: color.faint },
});
