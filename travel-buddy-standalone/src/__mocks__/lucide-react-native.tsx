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

// `size` is forwarded onto the stand-in View so tests can assert the size an
// icon actually renders at. Without it no test could observe lucide sizing at
// all, which is how a whole action row drifted out of alignment unnoticed —
// see components/ui/__tests__/ActionRowIcon.component.test.tsx.
// View's prop types reject unknown props; the test renderer just records them.
const ProbeView = View as unknown as React.ComponentType<Record<string, unknown>>;

const makeIcon = (name: string) =>
  function MockIcon({ size }: { size?: number; color?: string; [key: string]: unknown }) {
    return <ProbeView testID={`icon-${name}`} size={size} />;
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
