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

/**
 * The installed SDK (v11) exports `GeoJSONSource` plus a UNIFIED `Layer` with a
 * `type="fill"|"line"|"symbol"` prop — not the v10/rnmapbox
 * ShapeSource/FillLayer/LineLayer names. RouteMinimapView, RouteFullMapModal,
 * ActivityZone and CrowdFlowLine all use the v11 API, so without these two the
 * mock resolves them to `undefined` and every zone/flow renders nothing under
 * jest while passing silently. The ShapeSource/SymbolLayer/CircleLayer stubs
 * above are kept for older call sites.
 */
export const GeoJSONSource = (_props: any) => <View />;
export const Layer = (_props: any) => <View />;
export const FillLayer = (_props: any) => <View />;
export const LineLayer = (_props: any) => <View />;
export const UserLocation = (_props: any) => <View />;
export const PointAnnotation = (_props: any) => <View />;
export const MarkerView = (_props: any) => <View />;

Camera.displayName = 'Camera';

export default {
  Map,
  MapView,
  Camera,
  Marker,
  ShapeSource,
  SymbolLayer,
  CircleLayer,
  GeoJSONSource,
  Layer,
  FillLayer,
  LineLayer,
  UserLocation,
  PointAnnotation,
  MarkerView,
};
