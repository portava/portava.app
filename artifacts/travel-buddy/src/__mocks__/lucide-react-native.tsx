/**
 * Catch-all mock for lucide-react-native.
 *
 * Uses a JS Proxy so any named icon export (MapPin, Check, X, …) is
 * auto-generated as a simple <View testID="icon-<Name>" /> without needing
 * to be listed here explicitly. This eliminates "Element type is invalid"
 * failures when a new component test imports an icon not previously mocked.
 */
import React from 'react';
import { View } from 'react-native';

const makeIcon = (name: string) =>
  function MockIcon(_props: { size?: number; color?: string; [key: string]: unknown }) {
    return <View testID={`icon-${name}`} />;
  };

const cache: Record<string, ReturnType<typeof makeIcon>> = {};

const proxy = new Proxy(
  {},
  {
    get(_target, prop: string) {
      if (prop === '__esModule') return true;
      if (prop === 'default') return makeIcon('default');
      if (!cache[prop]) cache[prop] = makeIcon(prop);
      return cache[prop];
    },
  },
);

// Export via module.exports so the Proxy is the actual module object that
// Jest resolves named imports from (Babel rewrites named imports to
// property accesses on the module, which the Proxy intercepts).
// eslint-disable-next-line @typescript-eslint/no-require-imports
(module as NodeModule & { exports: unknown }).exports = proxy;
