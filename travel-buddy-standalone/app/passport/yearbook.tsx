/**
 * app/passport/yearbook.tsx
 *
 * Route wrapper for the Yearbook Passport surface (spec §9 / Phase 9). The
 * screen implementation lives in src/features/passport/YearbookScreen.tsx; this
 * file reads the optional `?year=` param and mounts it. The root Stack renders
 * headerShown:false, so YearbookScreen draws its own header.
 *
 * The yearbook endpoint (`GET /api/passport/me/yearbook`) is OWNER-PRIVATE — it
 * only ever serves the signed-in traveller's own yearbook — so this route takes
 * no target-user param.
 */
import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import YearbookScreen from '../../src/features/passport/YearbookScreen.tsx';

/** Parse `?year=2025` into a calendar year, or null for "every year". */
function readYearParam(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 1900 || parsed > 2200) return null;
  return parsed;
}

export default function YearbookRoute() {
  const params = useLocalSearchParams<{ year?: string }>();
  return <YearbookScreen year={readYearParam(params.year)} />;
}
