import type { Place } from './placeTypes.ts';

export interface ProfileLocationFields {
  homeCity: string;
  homeCountry: string;
  currentCity: string;
}

export type ProfileLocationPatch = Partial<{
  homeCity: string | null;
  homeCountry: string | null;
  currentCity: string | null;
}>;

export function normalizeProfileCitySelection(place: Place): { city: string; country: string } {
  return {
    city: place.city?.trim() || place.name.trim(),
    country: place.country?.trim() ?? '',
  };
}

export function profileLocationFieldsFrom(
  profile: Partial<Record<keyof ProfileLocationFields, string | null | undefined>>,
): ProfileLocationFields {
  return {
    homeCity: profile.homeCity ?? '',
    homeCountry: profile.homeCountry ?? '',
    currentCity: profile.currentCity ?? '',
  };
}

function nullableTrimmed(value: string): string | null {
  return value.trim() || null;
}

export function buildProfileLocationPatch(
  current: ProfileLocationFields,
  original: ProfileLocationFields,
): ProfileLocationPatch {
  const patch: ProfileLocationPatch = {};
  if (current.homeCity !== original.homeCity) {
    patch.homeCity = nullableTrimmed(current.homeCity);
  }
  if (current.homeCountry !== original.homeCountry) {
    patch.homeCountry = nullableTrimmed(current.homeCountry);
  }
  if (current.currentCity !== original.currentCity) {
    patch.currentCity = nullableTrimmed(current.currentCity);
  }
  return patch;
}