import React from 'react';
import { Alert } from 'react-native';
import { useFocusEffect, router } from 'expo-router';
import { SettingsSection, SettingsRow, FieldHint, ToggleRow } from '../settings/SettingsUI.tsx';
import { useInputAccountEpoch } from '../../platform/input-assistance/hooks/useInputAccountEpoch.ts';
import { currentDiscoveryScope, isCurrentDiscoveryScope } from '../../services/discoveryViewerScope.ts';
import { readProtectedPlaces, readMapRouteConsent, removeProtectedPlace, setMapRouteConsent, type ProtectedPlace, type RouteFlowConsent, type ProtectedCategory } from '../../services/mapPrivacy.ts';
export function MapPrivacySection() { const epoch = useInputAccountEpoch(); return <Controls key={epoch} />; }
function Controls() {
  const owner = React.useRef(currentDiscoveryScope()).current;
  const alive = React.useRef(true); const changing = React.useRef(false);
  const [places, setPlaces] = React.useState<ProtectedPlace[] | null>(null);
  const [consent, setConsent] = React.useState<RouteFlowConsent | null>(null);
  const [busy, setBusy] = React.useState(false); const [failure, setFailure] = React.useState<string | null>(null); const [attempt, setAttempt] = React.useState(0);
  const current = () => alive.current && isCurrentDiscoveryScope(owner);
  useFocusEffect(React.useCallback(() => { setAttempt(value => value + 1); }, []));
  React.useEffect(() => { alive.current = true; let live = true; setFailure(null);
    void Promise.allSettled([readProtectedPlaces(), readMapRouteConsent()]).then(([areas, route]) => {
      if (!live || !current()) return;
      if (areas.status === 'fulfilled') setPlaces(areas.value);
      if (route.status === 'fulfilled') setConsent(route.value);
      if (areas.status === 'rejected' || route.status === 'rejected') setFailure('Some map privacy settings could not be read. Please retry.');
    });
    return () => { live = false; alive.current = false; };
  }, [attempt, owner]);
  const change = async (work: () => Promise<void>) => {
    if (!current() || changing.current) return; changing.current = true; setBusy(true); setFailure(null);
    try { await work(); if (current()) setAttempt(value => value + 1); }
    catch { if (current()) setFailure('This change could not be confirmed. Retry when connected. A pending route withdrawal stops new route contributions from this device.'); }
    finally { changing.current = false; if (current()) setBusy(false); }
  };
  const words = consent?.disclosure;
  return <>
    <SettingsSection title="Protected places" subtitle="Choose an area on the map for home, work, or school. Only a rounded center and 1.5 km protective radius are stored, visible only to you. These areas suppress your location and route contributions.">
      {places === null ? <FieldHint>Protected places have not loaded.</FieldHint> : (['home', 'work', 'school'] as ProtectedCategory[]).map(category => {
        const saved = places.some(place => place.category === category);
        return <React.Fragment key={category}>
          <SettingsRow title={`${category[0].toUpperCase()}${category.slice(1)}${saved ? ' · protected' : ''}`} subtitle={saved ? 'Choose a different area' : 'Choose an area on the map'} disabled={busy} onPress={() => router.push({ pathname: '/map', params: { protectArea: category } } as never)} />
          {saved ? <SettingsRow title={`Remove ${category} protection`} danger disabled={busy} onPress={() => Alert.alert('Remove protection?', 'Your location and route contributions will follow your other sharing settings in this area.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Remove', style: 'destructive', onPress: () => { void change(() => removeProtectedPlace(category)); } }])} /> : null}
        </React.Fragment>;
      })}
    </SettingsSection>
    <SettingsSection title={words?.title ?? 'Route contributions'} subtitle={words ? [words.what, words.who, words.retention, words.off].join(' ') : 'Route contributions are unavailable until the disclosure is ready.'}>
      {consent ? <ToggleRow title="Contribute to area route trends" value={consent.granted} disabled={busy || consent.withdrawalPending === true || (!consent.granted && (!consent.available || !words))} onValueChange={value => { if (!value) setConsent(previous => previous ? { ...previous, granted: false, current: false, withdrawalPending: true } : previous); void change(() => setMapRouteConsent(value, value ? words?.version : undefined)); }} switchTestID="map-route-flow-consent" /> : null}
      {consent?.withdrawalPending ? <SettingsRow title="Retry route withdrawal" disabled={busy} onPress={() => { void change(() => setMapRouteConsent(false)); }} /> : null}
      {failure ? <><FieldHint tone="error">{failure}</FieldHint><SettingsRow title="Retry loading map privacy" onPress={() => setAttempt(value => value + 1)} /></> : null}
    </SettingsSection>
  </>;
}
