import type { ConfigContext, ExpoConfig } from 'expo/config';

/** Keys are platform-restricted build credentials. No key is created or enabled by this configuration. */
export default ({ config }: ConfigContext): ExpoConfig => {
  const iosKey = process.env.GOOGLE_MAPS_IOS_API_KEY?.trim();
  const androidKey = process.env.GOOGLE_MAPS_ANDROID_API_KEY?.trim();
  return { ...config, name: config.name ?? 'Portava', slug: config.slug ?? 'travel-buddy',
    ios: { ...config.ios, config: { ...config.ios?.config, ...(iosKey ? { googleMapsApiKey: iosKey } : {}) } },
    android: { ...config.android, config: { ...config.android?.config, ...(androidKey ? { googleMaps: { apiKey: androidKey } } : {}) } },
    extra: { ...config.extra, layoverGoogleMap: { ios: !!iosKey, android: !!androidKey } },
  };
};
