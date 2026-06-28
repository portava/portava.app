---
name: MapLibre React Native v11 API
description: Correct component names, prop names, and coordinate conventions for @maplibre/maplibre-react-native@11.3.6 — differs significantly from older versions and react-native-maps.
---

# MapLibre React Native v11 API

**Why:** v11 renamed and restructured many components vs. older releases. Relying on docs for older versions or react-native-maps conventions causes type errors.

## Component mapping (react-native-maps → MapLibre v11)

| react-native-maps | MapLibre v11 |
|---|---|
| `MapView` (default export) | `Map` (named export) |
| `Marker` with `coordinate={{ latitude, longitude }}` | `Marker` with `lngLat={[lng, lat]}` |
| `Polyline` | `GeoJSONSource` + `Layer type="line"` |
| `Circle` | `GeoJSONSource` + `Layer type="circle"` |
| `initialRegion={{ latitude, longitude, latitudeDelta, longitudeDelta }}` | `Camera initialViewState={{ center: [lng, lat], zoom: n }}` |
| `showsUserLocation`, `showsMyLocationButton` | `UserLocation` component (separate) |

## Key prop differences on `Map`

| react-native-maps | MapLibre v11 |
|---|---|
| `styleURL` | `mapStyle` (string or StyleSpecification) |
| `scrollEnabled` | `dragPan` |
| `zoomEnabled` | `touchZoom` |
| `rotateEnabled` | `touchRotate` |
| `pitchEnabled` | `touchPitch` |
| `showsCompass` | `compassEnabled` (on Map) |
| `logoEnabled={false}` | `logo={false}` |
| `attributionEnabled={false}` | `attribution={false}` |

## Coordinate order

MapLibre uses GeoJSON convention: **[longitude, latitude]** — opposite of react-native-maps/Google Maps.

```ts
// React-native-maps: { latitude: 48.8566, longitude: 2.3522 }
// MapLibre:          [2.3522, 48.8566]   (lng first)
```

## Camera

Camera sets viewport via `initialViewState` prop (declarative initial only). For programmatic updates, use a `CameraRef` and its imperative methods (`jumpTo`, `easeTo`, `flyTo`).

```tsx
<Camera initialViewState={{ center: [lng, lat], zoom: 12 }} />
```

Zoom from lat/lng delta approximation:
```ts
zoom = Math.min(Math.log2(360 / lngDelta), Math.log2(180 / latDelta)) - 0.5
```

## GeoJSONSource + Layer

```tsx
<GeoJSONSource id="unique-src-id" data={geoJsonFeature}>
  <Layer
    id="unique-layer-id"
    type="line"                         // or "circle", "fill", "symbol"
    paint={{
      'line-color': '#4A90D9',
      'line-width': 2,
      'line-dasharray': [6, 3],
    }}
  />
</GeoJSONSource>
```

GeoJSON feature shape (no import needed — use `as const` assertions):
```ts
const lineFeature = {
  type: 'Feature' as const,
  geometry: { type: 'LineString' as const, coordinates: [[lng1, lat1], [lng2, lat2]] },
  properties: {},
};
```

## TypeScript setup

`@types/geojson` must be in `devDependencies` of the travel-buddy package for `GeoJSON.*` global types to resolve when TypeScript checks `GeoJSONSource data` prop.

```json
"devDependencies": {
  "@types/geojson": "^7946.0.16"
}
```

## Marker

```tsx
<Marker lngLat={[lng, lat]}>
  <SomeReactElement />   // must be a single ReactElement child
</Marker>
```

`Marker` accepts a single `ReactElement` child rendered at the coordinate. Touch events work normally inside the child.

## How to apply

Any time MapLibre map components need to be written or modified in the travel-buddy app: use the names and props above. Do NOT look for `MarkerView`, `ShapeSource`, `LineLayer`, `CircleLayer`, or `styleURL` — they don't exist in v11.
