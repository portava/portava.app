/**
 * useMediaSurfaceDecisions — the owner's F1/F2 Media surface decisions, read
 * from FeatureFlagsContext (census-media §34). See ../state/mediaSurfaceFlags.ts
 * for what each flag does and why every one of them reads as TODAY until an
 * owner flips its row.
 *
 * Rendered outside a FeatureFlagsProvider (a component test, a web render),
 * the context default's isEnabled answers false for every key, so the caller
 * gets TODAY — the fail-closed direction.
 */
import { useFeatureFlags } from '../../../context/FeatureFlagsContext.tsx';
import { resolveMediaSurfaceDecisions, type MediaSurfaceDecisions } from '../state/mediaSurfaceFlags.ts';

export function useMediaSurfaceDecisions(): MediaSurfaceDecisions {
  const { isEnabled } = useFeatureFlags();
  return resolveMediaSurfaceDecisions(isEnabled);
}
