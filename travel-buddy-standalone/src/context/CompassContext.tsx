/**
 * CompassContext — lightweight context that exposes the user's Compass tier
 * and active-reward data across the app without prop-drilling.
 *
 * Populated by the frontload hook on auth resolve.  The provider lives in
 * _layout.tsx so every screen can call useCompassContext() to get the tier.
 */
import React, { createContext, useContext, useState } from 'react';
import type { CompassActiveReward, CompassFrontloadData } from '../services/compass';

interface CompassContextValue {
  reward:        CompassActiveReward | null;
  feedTier0:     CompassFrontloadData | null;
  compassEnabled: boolean;
  setReward:     (r: CompassActiveReward | null) => void;
  setFeedTier0:  (f: CompassFrontloadData | null) => void;
}

const CompassCtx = createContext<CompassContextValue>({
  reward:         null,
  feedTier0:      null,
  compassEnabled: false,
  setReward:      () => {},
  setFeedTier0:   () => {},
});

export function CompassProvider({ children }: { children: React.ReactNode }) {
  const [reward, setReward]       = useState<CompassActiveReward | null>(null);
  const [feedTier0, setFeedTier0] = useState<CompassFrontloadData | null>(null);

  const compassEnabled = Boolean(feedTier0?.compassEnabled);

  return (
    <CompassCtx.Provider value={{ reward, feedTier0, compassEnabled, setReward, setFeedTier0 }}>
      {children}
    </CompassCtx.Provider>
  );
}

export function useCompassContext(): CompassContextValue {
  return useContext(CompassCtx);
}
