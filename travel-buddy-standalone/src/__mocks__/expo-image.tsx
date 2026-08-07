/**
 * Minimal jest mock for expo-image.
 *
 * Renders a plain View with testID forwarded so:
 *  - Snapshot tests don't crash on the missing native module.
 *  - testID queries (getByTestId) still resolve in component tests.
 *
 * `source` and `onError` are forwarded too. Without `source` no test can
 * assert WHICH url a surface bound, which is the whole failure mode behind the
 * blank-media bug: the app happily bound `post-media/<uid>/<file>.jpg` — a
 * bare storage reference with no scheme — and every assertion still passed.
 *
 * Two-file rule: if a test needs richer Image behaviour, add a per-file
 * jest.mock('expo-image', ...) factory — it overrides this stub.
 */
import React from 'react';
import { View } from 'react-native';

export const Image = ({
  testID,
  style,
  accessibilityLabel,
  source,
  onError,
}: {
  testID?: string;
  style?: any;
  accessibilityLabel?: string;
  source?: unknown;
  onError?: () => void;
}) => (
  <View
    testID={testID}
    style={style}
    accessibilityLabel={accessibilityLabel}
    // @ts-expect-error — test-only passthrough so assertions can read them.
    source={source}
    onError={onError}
  />
);

// expo-image also exports types; export a stub so type-only imports don't fail.
export type ImageContentFit = string;
export type ImageSource = object;

export default { Image };
