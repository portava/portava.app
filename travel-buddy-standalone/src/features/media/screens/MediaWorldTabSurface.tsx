/**
 * MediaWorldTabSurface — the World shell as the Media TAB's own opening mode
 * (census-media §34, owner decision F1: MD1, MD3, MD11, MD29, MD87, MD286,
 * MD402, MD419, MD425, MD427).
 *
 * Mounted by app/(tabs)/media.tsx only while the tab's `world` mode is selected,
 * which exists only while MEDIA_WORLD_SHELL_ENABLED and
 * MEDIA_TAB_WORLD_DEFAULT_ENABLED are both on (state/mediaSurfaceFlags.ts). With
 * either off — the seeded state — nothing here renders and the tab is exactly
 * what it was.
 *
 * It is the same shell the /media-world route mounts, fed the same coarse
 * location inputs (app/media-world/index.tsx): the World → Place → Time → People
 * → Media hierarchy, every open through a §14 entry context, no autoplaying
 * paging feed. The tab's mode switcher (World · Watch · Grid · Gems) sits under
 * the World header, so Watch stays one tap away and is simply no longer where
 * the tab opens.
 */
import React from 'react';
import { MediaWorldShell } from './MediaWorldShell.tsx';
import { useActiveLocation } from '../../../hooks/useActiveLocation.ts';

export interface MediaWorldTabSurfaceProps {
  /** The Media tab's mode switcher, drawn under the World header. */
  modeSwitcher?: React.ReactNode;
}

export function MediaWorldTabSurface({ modeSwitcher }: MediaWorldTabSurfaceProps) {
  const { locationState } = useActiveLocation();
  const coords = locationState.ok ? locationState.coords : null;
  const cityId = locationState.place?.canonicalId ?? locationState.place?.id ?? null;
  const cityName = locationState.place?.city ?? null;
  return (
    <MediaWorldShell
      cityId={cityId}
      cityName={cityName}
      lat={coords?.lat ?? null}
      lng={coords?.lng ?? null}
      headerAccessory={modeSwitcher}
    />
  );
}
