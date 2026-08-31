/**
 * Media tab screen — Watch · Grid · Gems navigation shell.
 *
 * Gated by MEDIA_TAB_ENABLED feature flag (the tab is hidden from the nav bar
 * when the flag is off, but the route is registered so deep-links still work).
 *
 * Each mode owns independent state via MediaStoreProvider. The mode selector
 * sits inside the safe area at the top of the screen. A floating camera/create
 * button (bottom-right) navigates to /create in Watch and Grid modes. In Gems
 * mode the button opens MediaQuickCreateSheet which offers both "Add a Gem"
 * (when MEDIA_HIDDEN_GEMS_CREATE_ENABLED is on) and all standard creation types.
 *
 * useFocusEffect emits MEDIA_PAUSE_ALL when the screen blurs so any future
 * player instances pause automatically on tab switch.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import { Camera, Gem, Globe } from 'lucide-react-native';

import { useFeatureFlags } from '../../src/context/FeatureFlagsContext';
import {
  MediaStoreProvider,
  useMediaStore,
  type MediaMode,
} from '../../src/stores/mediaStore';
import { MediaModeSelector } from '../../src/components/media/MediaModeSelector';
import { WatchFeed } from '../../src/components/media/WatchFeed';
import { GridFeed } from '../../src/components/media/GridFeed';
import { GemsFeed } from '../../src/components/media/GemsFeed';
import { MediaQuickCreateSheet } from '../../src/components/media/MediaQuickCreateSheet';
import { mediaEvents } from '../../src/lib/mediaEvents';
import { color, shadow, avatar } from '../../src/theme/tokens';
import { AppHeader, getOverlayHeaderTotalHeight } from '../../src/components/ui/AppHeader';
import { useLayoverAwareBottomInset } from '../../src/hooks/useBottomInset';

// ── Mode definitions ──────────────────────────────────────────────────────────

interface ModeItem {
  key: MediaMode;
  label: string;
  /** Feature flag that controls whether this mode is visible. */
  flagKey: string;
}

const ALL_MODES: ModeItem[] = [
  { key: 'watch', label: 'Watch', flagKey: 'MEDIA_VIEW_MODE_FULLSCREEN_ENABLED' },
  { key: 'grid',  label: 'Grid',  flagKey: 'MEDIA_VIEW_MODE_GRID_ENABLED' },
  { key: 'gems',  label: 'Gems',  flagKey: 'MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED' },
];

// ── Inner screen (reads store after provider is mounted) ──────────────────────

function MediaScreenInner() {
  const insets = useSafeAreaInsets();
  const bottomInset = useLayoverAwareBottomInset();
  const { isEnabled } = useFeatureFlags();
  const { selectedMode, setMode } = useMediaStore();

  const [quickSheetOpen, setQuickSheetOpen] = useState(false);

  // Filter out modes disabled by feature flags.
  const enabledModes = useMemo(
    () => ALL_MODES.filter(({ flagKey }) => isEnabled(flagKey)),
    [isEnabled],
  );

  // Emit MEDIA_PAUSE_ALL when the tab loses focus so future players pause cleanly.
  useFocusEffect(
    useCallback(() => {
      return () => {
        mediaEvents.emit('MEDIA_PAUSE_ALL');
      };
    }, []),
  );

  // Grid mode uses a solid paper surface; Watch and Gems use the dark immersive bg.
  const isImmersive = selectedMode !== 'grid';
  const screenBg = isImmersive ? color.ink : color.paper;

  // In Gems mode: open the quick-create sheet (which offers "Add a Gem" + others).
  // In Watch/Grid mode: navigate directly to /create.
  const isGemsMode = selectedMode === 'gems';

  function handleFabPress() {
    if (isGemsMode) {
      setQuickSheetOpen(true);
    } else {
      router.push('/create');
    }
  }

  // Grid mode: content must clear the mode-selector pill, which sits at
  // (insets.top + 8) and is 44 px tall, plus a 4 px breathing gap.
  const GRID_SELECTOR_CLEARANCE = 56; // 8 gap + 44 pill + 4 gap

  return (
    <View style={[styles.screen, { backgroundColor: screenBg }]}>
      {/* ── Mode content (fills remaining space) ────────────────────── */}
      <View style={styles.content}>
        {selectedMode === 'watch' && <WatchFeed />}
        {selectedMode === 'grid'  && (
          <View style={{ flex: 1, paddingTop: insets.top + GRID_SELECTOR_CLEARANCE }}>
            <GridFeed />
          </View>
        )}
        {selectedMode === 'gems'  && (
          <GemsFeed
            nearMeEnabled={isEnabled('MEDIA_HIDDEN_GEMS_NEARBY_ENABLED')}
            onViewPlace={(item) => {
              const placeId = item.location?.canonicalPlaceId;
              if (placeId) router.push(`/place/${placeId}` as any);
            }}
          />
        )}
      </View>

      {/* ── Overlay header for immersive modes (Watch / Gems) ───────── */}
      {isImmersive && (
        <AppHeader
          variant="overlay"
          title={selectedMode === 'watch' ? 'Watch' : 'Gems'}
        />
      )}

      {/* ── Mode selector — overlaid at the top, inside safe area ───── */}
      {enabledModes.length > 1 && (
        <View
          style={[styles.selectorOverlay, { top: isImmersive ? getOverlayHeaderTotalHeight(insets.top) + 4 : insets.top + 8 }]}
          pointerEvents="box-none"
        >
          <MediaModeSelector
            modes={enabledModes}
            selectedMode={selectedMode}
            onSelect={setMode}
          />
        </View>
      )}

      {/* ── Grid mode: subtle create button at top-right (screen coordinates)
          Rendered here — not inside GridFeed — so `top` is measured from the
          screen's safe-area origin, not GridFeed's offset container.         */}
      {selectedMode === 'grid' && (
        <Pressable
          style={[styles.gridCreateBtn, { top: insets.top + 8 }]}
          onPress={() => router.push('/create')}
          accessibilityRole="button"
          accessibilityLabel="Create a post"
          hitSlop={8}
        >
          <Camera size={18} color={color.ink} strokeWidth={2} />
        </Pressable>
      )}

      {/* ── Floating create button ───────────────────────────────────── */}
      {/* In Gems mode: Gem icon that opens the quick-create sheet.
          In Watch / Grid: Camera icon that navigates directly to /create. */}
      <Pressable
        style={[
          styles.fab,
          isGemsMode && styles.fabGems,
          { bottom: bottomInset + 16 },
        ]}
        onPress={handleFabPress}
        accessibilityRole="button"
        accessibilityLabel={isGemsMode ? 'Add a Gem' : 'Create a post'}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        {isGemsMode ? (
          <Gem size={22} color="#fff" strokeWidth={2} />
        ) : (
          <Camera size={22} color="#fff" strokeWidth={2} />
        )}
      </Pressable>

      {/* ── World shell entry (additive; flag-gated) ─────────────────
          A subtle top-left pill opening the new World-first Media shell
          (/media-world). Hidden unless MEDIA_WORLD_SHELL_ENABLED is on, so
          this tab's default behaviour is completely unchanged when the flag
          is absent (fail-soft isEnabled → false). Additive: the Watch/Grid/
          Gems surface below is untouched. */}
      {isEnabled('MEDIA_WORLD_SHELL_ENABLED') && (
        <Pressable
          style={[
            styles.worldEntryBtn,
            { top: insets.top + 8 },
            !isImmersive && styles.worldEntryBtnLight,
          ]}
          onPress={() => router.push('/media-world')}
          accessibilityRole="button"
          accessibilityLabel="Open the World media shell"
          hitSlop={8}
        >
          <Globe size={15} color={isImmersive ? '#fff' : color.ink} strokeWidth={2.2} />
          <Text style={[styles.worldEntryText, { color: isImmersive ? '#fff' : color.ink }]}>World</Text>
        </Pressable>
      )}

      {/* ── Quick-create sheet (Gems mode only) ─────────────────────── */}
      <MediaQuickCreateSheet
        visible={quickSheetOpen}
        onClose={() => setQuickSheetOpen(false)}
        showGemEntry={isGemsMode}
      />
    </View>
  );
}

// ── Root export (wraps in MediaStoreProvider) ─────────────────────────────────

export default function MediaScreen() {
  const { isEnabled, loading: flagsLoading } = useFeatureFlags();

  // Determine enabled modes to pass as hint to the store for defaultMode logic.
  // When flags are still loading, pass all modes so the store doesn't snap to
  // an empty set; reconciliation runs again once flagsLoading becomes false.
  const enabledModes = useMemo<MediaMode[]>(
    () =>
      flagsLoading
        ? ['watch', 'grid', 'gems']
        : ALL_MODES
            .filter(({ flagKey }) => isEnabled(flagKey))
            .map(({ key }) => key),
    [isEnabled, flagsLoading],
  );

  // Resolve default mode: first enabled mode after flags load.
  const defaultMode: MediaMode = flagsLoading ? 'watch' : (enabledModes[0] ?? 'watch');

  return (
    <MediaStoreProvider
      defaultMode={defaultMode}
      enabledModes={enabledModes}
      flagsLoading={flagsLoading}
    >
      <MediaScreenInner />
    </MediaStoreProvider>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  content: {
    flex: 1,
  },
  selectorOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 10,
    // pointerEvents="box-none" set on the View so touches pass through
    // to the content behind, except for the selector itself.
  },
  fab: {
    position: 'absolute',
    right: 20,
    width: avatar.s52, height: avatar.s52,
    borderRadius: avatar.s52 / 2,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
    ...shadow.float,
  },
  fabGems: {
    // Gem-mode FAB uses the gem green accent instead of signal red.
    backgroundColor: '#10B981',
  },
  // World shell entry pill — top-left, subtle; additive (flag-gated).
  worldEntryBtn: {
    position: 'absolute',
    left: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: 'rgba(17,17,15,0.45)',
    zIndex: 20,
  },
  worldEntryBtnLight: {
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
  },
  worldEntryText: {
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  // Grid-mode create button: subtle, positioned at screen top-right (not inside
  // the GridFeed offset container, so safe-area inset is not double-counted).
  gridCreateBtn: {
    position: 'absolute',
    right: 16,
    width: avatar.s36, height: avatar.s36,
    borderRadius: avatar.s36 / 2,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
    ...shadow.card,
  },
});
