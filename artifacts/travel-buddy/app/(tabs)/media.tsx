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
  Pressable,
  StyleSheet,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import { Camera, Gem } from 'lucide-react-native';

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
import { color, shadow } from '../../src/theme/tokens';
import { useBottomInset } from '../../src/hooks/useBottomInset';

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
  const bottomInset = useBottomInset();
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

  return (
    <View style={[styles.screen, { backgroundColor: screenBg }]}>
      {/* ── Mode content (fills remaining space) ────────────────────── */}
      <View style={styles.content}>
        {selectedMode === 'watch' && <WatchFeed />}
        {selectedMode === 'grid'  && <GridFeed />}
        {selectedMode === 'gems'  && (
          <GemsFeed
            nearMeEnabled={isEnabled('MEDIA_HIDDEN_GEMS_NEARBY_ENABLED')}
          />
        )}
      </View>

      {/* ── Mode selector — overlaid at the top, inside safe area ───── */}
      {enabledModes.length > 1 && (
        <View
          style={[styles.selectorOverlay, { top: insets.top + 8 }]}
          pointerEvents="box-none"
        >
          <MediaModeSelector
            modes={enabledModes}
            selectedMode={selectedMode}
            onSelect={setMode}
          />
        </View>
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
    width: 52,
    height: 52,
    borderRadius: 26,
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
});
