import {
  buildProfileLocationPatch,
  normalizeProfileCitySelection,
  profileLocationFieldsFrom,
} from '../profileLocationFields.ts';
import type { Place } from '../placeTypes.ts';

function place(overrides: Partial<Place> = {}): Place {
  return {
    id: 'canonical-cebu',
    canonicalId: 'canonical-cebu',
    type: 'city',
    name: 'Cebu',
    displayName: 'Cebu City, Philippines',
    country: ' Philippines ',
    countryCode: 'PH',
    region: null,
    city: ' Cebu City ',
    district: null,
    lat: null,
    lng: null,
    timezone: 'Asia/Manila',
    source: 'canonical',
    ...overrides,
  };
}

describe('profile location field contract', () => {
  it('normalizes a canonical picker result once at the profile boundary', () => {
    expect(normalizeProfileCitySelection(place())).toEqual({
      city: 'Cebu City',
      country: 'Philippines',
    });
    expect(normalizeProfileCitySelection(place({ city: null, name: ' Tokyo ', country: ' Japan ' })))
      .toEqual({ city: 'Tokyo', country: 'Japan' });
  });

  it('builds replacements, no-op cancels, and explicit null clears', () => {
    const original = { homeCity: 'London', homeCountry: 'UK', currentCity: 'Paris' };
    expect(buildProfileLocationPatch(original, original)).toEqual({});
    expect(buildProfileLocationPatch(
      { ...original, homeCity: 'Tokyo', homeCountry: 'Japan' },
      original,
    )).toEqual({ homeCity: 'Tokyo', homeCountry: 'Japan' });
    expect(buildProfileLocationPatch(
      { homeCity: '', homeCountry: ' ', currentCity: '' },
      original,
    )).toEqual({ homeCity: null, homeCountry: null, currentCity: null });
  });

  it('rehydrates nullable backend fields into the editor form', () => {
    expect(profileLocationFieldsFrom({
      homeCity: 'Cebu City',
      homeCountry: 'Philippines',
      currentCity: null,
    })).toEqual({
      homeCity: 'Cebu City',
      homeCountry: 'Philippines',
      currentCity: '',
    });
  });
});