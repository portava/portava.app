/**
 * TravelBuddyLoader — the single entry point for loading states across the app.
 *
 * Two jobs:
 *   1. CONTEXTUAL: map a loading *context* to the right loader, so the animation
 *      communicates what's happening (GPS → Pulse Pin, AI → Compass Lock, etc.).
 *   2. VARIETY: for generic full-screen loads, optionally rotate among the
 *      "delight" loaders so users see variety instead of the same animation.
 *
 * This matches the loading spec's §9: use the right loader by context; don't show
 * a large full-screen loader for a small inline action.
 *
 * Tokens-only children; no new colors here.
 */
import React, { useMemo } from 'react';
import type { ViewStyle } from 'react-native';
import { PassportStampLoader } from './PassportStampLoader';
import { PulsePinLoader } from './PulsePinLoader';
import { CompassLockLoader } from './CompassLockLoader';
import { RoutePathLoader } from './RoutePathLoader';
import { TelegraphLoader } from './TelegraphLoader';

/**
 * Loading context. Pick the one that matches what's actually loading.
 * - 'app' / 'screen'    → full-screen Passport Stamp (or rotated, see `rotate`)
 * - 'location' / 'gps'  → Pulse Pin
 * - 'ai' / 'compass'    → Compass Lock
 * - 'route' / 'trip'    → Route Path itinerary
 * - 'chat' / 'message'  → Telegraph
 */
export type LoaderContext =
  | 'app'
  | 'screen'
  | 'location'
  | 'gps'
  | 'ai'
  | 'compass'
  | 'route'
  | 'trip'
  | 'chat'
  | 'message';

export interface TravelBuddyLoaderProps {
  /** What is loading. Determines which animation shows. Default 'screen'. */
  context?: LoaderContext;
  /** Override rotating copy passed down to the chosen loader. */
  messages?: string[];
  /** Compact/inline variant where the chosen loader supports it (location/ai/chat). */
  compact?: boolean;
  /**
   * For generic full-screen contexts ('app'/'screen'), rotate among the
   * full-screen "delight" loaders so repeated loads feel varied. Ignored for
   * contextual loaders (those must stay tied to their meaning). Default false.
   */
  rotate?: boolean;
  /** Stamp label for the Passport loader (e.g. a destination). */
  stampLabel?: string;
  style?: ViewStyle;
  accessibilityLabel?: string;
}

// Full-screen loaders eligible for random rotation on generic loads.
// Pulse Pin / Compass Lock / Telegraph are intentionally NOT here — they carry
// specific meaning and shouldn't appear for a generic screen load.
const ROTATION_POOL = ['passport', 'route'] as const;
type RotationKey = (typeof ROTATION_POOL)[number];

function pickRotation(): RotationKey {
  return ROTATION_POOL[Math.floor(Math.random() * ROTATION_POOL.length)];
}

export function TravelBuddyLoader({
  context = 'screen',
  messages,
  compact = false,
  rotate = false,
  stampLabel,
  style,
  accessibilityLabel,
}: TravelBuddyLoaderProps) {
  // Decide once per mount so it doesn't flip mid-load.
  const rotated = useMemo<RotationKey>(() => pickRotation(), []);

  switch (context) {
    case 'location':
    case 'gps':
      return (
        <PulsePinLoader
          messages={messages}
          compact={compact}
          style={style}
          accessibilityLabel={accessibilityLabel}
        />
      );

    case 'ai':
    case 'compass':
      return (
        <CompassLockLoader
          messages={messages}
          compact={compact}
          style={style}
          accessibilityLabel={accessibilityLabel}
        />
      );

    case 'route':
    case 'trip':
      return (
        <RoutePathLoader
          messages={messages}
          style={style}
          accessibilityLabel={accessibilityLabel}
        />
      );

    case 'chat':
    case 'message':
      return (
        <TelegraphLoader
          messages={messages}
          compact={compact}
          style={style}
          accessibilityLabel={accessibilityLabel}
        />
      );

    case 'app':
    case 'screen':
    default: {
      if (rotate && rotated === 'route') {
        return (
          <RoutePathLoader
            messages={messages}
            style={style}
            accessibilityLabel={accessibilityLabel}
          />
        );
      }
      return (
        <PassportStampLoader
          messages={messages}
          stampLabel={stampLabel}
          style={style}
          accessibilityLabel={accessibilityLabel}
        />
      );
    }
  }
}

export default TravelBuddyLoader;
