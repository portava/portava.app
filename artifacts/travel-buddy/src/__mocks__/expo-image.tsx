/**
 * Minimal jest mock for expo-image.
 *
 * Renders a plain View with testID forwarded so:
 *  - Snapshot tests don't crash on the missing native module.
 *  - testID queries (getByTestId) still resolve in component tests.
 *
 * Two-file rule: if a test needs to assert on Image behaviour (e.g. onError),
 * add a per-file jest.mock('expo-image', ...) factory — it overrides this stub.
 */
import React from 'react';
import { View } from 'react-native';

export const Image = ({ testID, style }: { testID?: string; style?: any }) => (
  <View testID={testID} style={style} />
);

// expo-image also exports types; export a stub so type-only imports don't fail.
export type ImageContentFit = string;
export type ImageSource = object;

export default { Image };
