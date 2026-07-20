/**
 * PostCard — stub component (standalone tree).
 *
 * This file exists so standalone test suites that `jest.mock` the PostCard
 * module can resolve the module path. The real PostCard implementation lives
 * in the canonical mobile tree (artifacts/travel-buddy) and is not needed in
 * the standalone EAS-build mirror.
 */

import React from 'react';
import { View } from 'react-native';

export function PostCard() {
  return <View />;
}
