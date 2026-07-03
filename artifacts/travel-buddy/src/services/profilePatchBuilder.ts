/**
 * Pure patch-builder helpers for profile update flows.
 *
 * Extracted from onboarding.tsx (handleFinish) and PassportSettingsSheet.tsx
 * (handleSave) so that:
 *   - Each component imports and calls these functions (single source of truth)
 *   - Tests import the same functions and exercise real production logic
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

// ── Passport Settings Sheet (src/components/PassportSettingsSheet.tsx) ────────

export interface PassportSettingsFormState {
  displayName: string;
  bio: string;
  homeCity: string;
  homeCountry: string;
  passportPublic: boolean;
  interests: string[];
  spokenLanguages: string[];
  defaultLanguage: string;
  travelStyles: string[];
  travelPace: string | null;
  budgetStyle: string | null;
  travelGroupStyle: string[];
  lookingFor: string[];
  comfortLevel: string | null;
  availabilityTags: string[];
  planningStyle: string | null;
  currentUsername: string;
  newUsername: string;
  usernameStatus: string;
}

/**
 * Builds the profile patch sent by PassportSettingsSheet on save.
 * Empty strings become undefined (stripped from JSON.stringify) so
 * the API only receives fields the user actually filled in.
 */
export function buildPassportSettingsPatch(state: PassportSettingsFormState): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    displayName: state.displayName.trim() || undefined,
    bio: state.bio.trim() || undefined,
    homeCity: state.homeCity.trim() || undefined,
    homeCountry: state.homeCountry.trim() || undefined,
    interests: state.interests,
    passportVisibility: state.passportPublic ? 'public' : 'private',
    spokenLanguages: state.spokenLanguages,
    defaultLanguage: state.defaultLanguage.trim() || null,
    travelStyles: state.travelStyles,
    travelPace: state.travelPace ?? null,
    budgetStyle: state.budgetStyle ?? null,
    travelGroupStyle: state.travelGroupStyle,
    lookingFor: state.lookingFor,
    comfortLevel: state.comfortLevel ?? null,
    availabilityTags: state.availabilityTags,
    planningStyle: state.planningStyle ?? null,
  };
  if (
    state.newUsername &&
    state.newUsername !== state.currentUsername &&
    state.usernameStatus !== 'unavailable'
  ) {
    patch.username = state.newUsername;
  }
  return patch;
}
