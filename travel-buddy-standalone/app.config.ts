import type { ConfigContext, ExpoConfig } from 'expo/config';
import * as ConfigPluginsNamespace from 'expo/config-plugins';

type ConfigPlugins = typeof import('expo/config-plugins');

/**
 * `expo/config-plugins` is CommonJS. Expo's own config loader transpiles this
 * file to CommonJS, where the namespace import IS the module; the node:test
 * suite loads it as ESM (tsx/esm on Node 24), where Node cannot detect the
 * module's getter-defined named exports and parks the whole thing on
 * `.default`. A named import therefore throws at load time under one loader
 * or the other; resolving the function at call time works under both.
 */
function configPlugins(): ConfigPlugins {
  const ns = ConfigPluginsNamespace as unknown as Record<string, unknown>;
  for (const candidate of [ns, ns.default]) {
    if (candidate && typeof (candidate as Record<string, unknown>).withEntitlementsPlist === 'function') {
      return candidate as ConfigPlugins;
    }
  }
  throw new Error('expo/config-plugins did not expose withEntitlementsPlist under this module loader');
}

/**
 * PORTAVA_PERSONAL_TEAM=1 — a local Xcode build signed with a free Apple ID (a
 * "Personal Team": no Developer Program membership, own devices only, 7-day
 * expiry). Personal Teams cannot sign three of this app's capabilities, so with
 * the switch on the generated iOS project carries none of them:
 *
 *   - Sign in with Apple        (the expo-apple-authentication plugin)
 *   - universal links           (ios.associatedDomains)
 *   - push notifications        (aps-environment, which expo-notifications'
 *                                autolinked plugin adds without being listed)
 *
 * The app treats each as unavailable at runtime: the sign-in screen hides the
 * Apple button when `extra.signInWithApple` is false (src/lib/buildCapabilities.ts),
 * usePushToken.ts swallows a failed token registration, and universal links
 * simply open the website. Read at config time only and never set in EAS, so
 * store builds are unaffected. Usage: docs/eas-runbook.md ("Local iPhone build
 * with a Personal Team").
 */
export const PERSONAL_TEAM_ENV = 'PORTAVA_PERSONAL_TEAM';
const PERSONAL_TEAM_PLUGINS_DROPPED: ReadonlySet<string> = new Set(['expo-apple-authentication']);
export const PERSONAL_TEAM_ENTITLEMENTS_DROPPED: readonly string[] = [
  'aps-environment',
  'com.apple.developer.applesignin',
  'com.apple.developer.associated-domains',
];

export function isPersonalTeamBuild(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return /^(1|true|yes)$/i.test((env[PERSONAL_TEAM_ENV] ?? '').trim());
}

function pluginName(entry: NonNullable<ExpoConfig['plugins']>[number]): string {
  return String(Array.isArray(entry) ? entry[0] : entry);
}

/** The config a Personal Team can sign: the three capabilities above removed at the source and from the entitlements file. */
export function withPersonalTeam(config: ExpoConfig): ExpoConfig {
  const { associatedDomains: _dropped, ...ios } = config.ios ?? {};
  const plugins = (config.plugins ?? []).filter((entry) => !PERSONAL_TEAM_PLUGINS_DROPPED.has(pluginName(entry)));
  const stripped: ExpoConfig = {
    ...config,
    ios: { ...ios, usesAppleSignIn: false },
    plugins,
    // Read by src/lib/buildCapabilities.ts: this binary cannot show the Apple
    // sheet, and it is a test build (the sign-in screen names its backend).
    extra: { ...config.extra, signInWithApple: false, personalTeam: true },
  };
  // Belt and braces for the entitlement a plugin writes rather than the config declares (aps-environment).
  return configPlugins().withEntitlementsPlist(stripped, (c) => {
    for (const key of PERSONAL_TEAM_ENTITLEMENTS_DROPPED) delete c.modResults[key];
    return c;
  });
}

/** Keys are platform-restricted build credentials. No key is created or enabled by this configuration. */
export default ({ config }: ConfigContext): ExpoConfig => {
  const iosKey = process.env.GOOGLE_MAPS_IOS_API_KEY?.trim();
  const androidKey = process.env.GOOGLE_MAPS_ANDROID_API_KEY?.trim();
  const resolved: ExpoConfig = { ...config, name: config.name ?? 'Portava', slug: config.slug ?? 'travel-buddy',
    ios: { ...config.ios, config: { ...config.ios?.config, ...(iosKey ? { googleMapsApiKey: iosKey } : {}) } },
    android: { ...config.android, config: { ...config.android?.config, ...(androidKey ? { googleMaps: { apiKey: androidKey } } : {}) } },
    extra: { ...config.extra, layoverGoogleMap: { ios: !!iosKey, android: !!androidKey } },
  };
  return isPersonalTeamBuild() ? withPersonalTeam(resolved) : resolved;
};
