/**
 * Stub for @maplibre/maplibre-react-native.
 *
 * The real package requires native camera/GL modules that are unavailable in
 * the jest-expo runner.  This stub exports null-render components so any
 * screen that imports from @maplibre/maplibre-react-native can be tested
 * without crashing the suite.
 */
import React from 'react';
import { View } from 'react-native';

export const Map = (_props: any) => <View testID="maplibre-map" />;
export const MapView = (_props: any) => <View testID="maplibre-map" />;
export const Camera = React.forwardRef((_props: any, _ref: any) => <View />);
export const Marker = (_props: any) => <View />;
export const ShapeSource = (_props: any) => <View />;
export const SymbolLayer = (_props: any) => <View />;
export const CircleLayer = (_props: any) => <View />;

Camera.displayName = 'Camera';

export default { Map, MapView, Camera, Marker, ShapeSource, SymbolLayer, CircleLayer };
