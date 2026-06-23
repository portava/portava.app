/**
 * DiscoveryMapView.web.tsx — web stub.
 * react-native-maps uses native modules unavailable on web.
 * Metro picks this file automatically when bundling for web,
 * so the native DiscoveryMapView.tsx is never compiled there.
 * The map toggle in discovery.tsx is already hidden on web (Platform check),
 * so this component should never actually render — it exists purely as a
 * safe fallback.
 */
import type { DiscoveryPlace } from '../../services/discovery';

export interface DiscoveryMapViewProps {
  places: DiscoveryPlace[];
  onSelectPlace: (place: DiscoveryPlace) => void;
}

export function DiscoveryMapView(_props: DiscoveryMapViewProps): null {
  return null;
}
