/**
 * Pure patch-builder helpers for profile update flows.
 *
 * Extracted from onboarding.tsx (handleFinish) so that:
 *   - The component imports and calls this function (single source of truth)
 *   - Tests import the same function and exercise real production logic
 *
 * No React imports — safe to load in node:test environments.
 */
import type { UpdateProfileInput } from './profile';

// ── Onboarding (app/(auth)/onboarding.tsx) ───────────────────────────────────

export interface OnboardingFormState {
  displayName: string;
  handle: string;
  homeCity: string;
  homeCountry: string;
  travelStyle: string;
  interests: string[];
}

/**
 * Builds the UpdateProfileInput patch for the onboarding finish step.
 * Trims all string fields. Empty / whitespace-only fields are omitted from
 * the patch so the API doesn't overwrite existing values with blank strings.
 */
export function buildOnboardingPatch(state: OnboardingFormState): UpdateProfileInput {
  const patch: UpdateProfileInput = {
    interests: state.interests as any,
    travelStyle: state.travelStyle,
  };
  const trimmedName = state.displayName.trim();
  const trimmedHandle = state.handle.trim().replace(/^@/, '');
  const trimmedCity = state.homeCity.trim();
  const trimmedCountry = state.homeCountry.trim();
  if (trimmedName) patch.displayName = trimmedName;
  if (trimmedHandle) patch.username = trimmedHandle;
  if (trimmedCity) patch.homeCity = trimmedCity;
  if (trimmedCountry) patch.homeCountry = trimmedCountry;
  return patch;
}
