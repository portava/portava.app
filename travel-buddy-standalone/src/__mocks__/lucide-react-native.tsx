import React from 'react';
import { View } from 'react-native';

const icon = (name: string) =>
  function MockIcon(props: { size?: number; color?: string }) {
    return <View testID={`icon-${name}`} />;
  };

export const X = icon('X');
export const MoreVertical = icon('MoreVertical');
export const Share2 = icon('Share2');
export const Flag = icon('Flag');
export default icon('default');
