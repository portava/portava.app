import React from 'react';
import { UIManager } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';
import Constants from 'expo-constants';
import { LayoverGoogleRouteMap } from '../LayoverGoogleRouteMap';
import { LayoverAirportLayout } from '../LayoverAirportLayout.tsx';
import { LayoverRoutedMapLayer } from '../LayoverRoutedMapLayer.tsx';
import { cacheCertifiedPlan, readCachedPlan } from '../../../lib/layoverPlanCache.ts';
import AsyncStorage from '@react-native-async-storage/async-storage';
jest.mock('expo-constants', () => ({ ...jest.requireActual('expo-constants'), __esModule: true, default: { expoConfig: { extra: { layoverGoogleMap: { ios: true, android: true } } } } }));
jest.mock('react-native-maps', () => {
  const React = require('react'), { View, Pressable, Text } = require('react-native');
  return { __esModule: true, PROVIDER_GOOGLE: 'google', default: React.forwardRef((p: any, _ref: unknown) => <View testID={`native-map-${p.provider}`}>{p.children}</View>),
    Marker: (p: any) => <Text>{p.title}</Text>, Polyline: (p: any) => <Pressable testID="provider-polyline" onPress={p.onPress}><Text>{JSON.stringify(p.coordinates)}</Text></Pressable>,
    Polygon: (p: any) => <Pressable testID="provider-polygon" onPress={p.onPress}><Text>{JSON.stringify(p.holes)}</Text></Pressable> };
});
jest.mock('@maplibre/maplibre-react-native', () => {
  const { View, Pressable, Text } = require('react-native');
  return { GeoJSONSource: (p: any) => <View testID={p.id}><Pressable onPress={() => p.onPress?.({ nativeEvent: { features: [p.data.features[0]] } })}><Text>Tap source feature</Text></Pressable>{p.children}</View>, Layer: () => null };
});
jest.mock('../../discovery/DiscoveryMapView', () => ({ ...jest.requireActual('../../discovery/DiscoveryMapView'), DiscoveryMapView: ({ children }: any) => children }));
const NOW = Date.parse('2030-06-14T09:00:00Z'), SNAP = `snap:${'a'.repeat(32)}`;
const line = { provider: 'google_maps', displayPolicy: 'google_map_only', cachePolicy: 'no_store', geometry: { type: 'LineString', coordinates: [[103.9,1.3],[103.91,1.31]] } };
const expiry = new Date(NOW+300000).toISOString();
const envelope = { centre: { lat:1.3,lng:103.9 }, basis:'routed_union', certifiedInward:true, certifiedOutward:false,polygonInteriorCertified:false,outerBound:null,
  windowStartsAt:new Date(NOW).toISOString(),hardReturnBy:new Date(NOW+3600000).toISOString(),usableMinutes:60,dwellFloorMinutes:30,confidence:'LOW',members:[],excluded:[],sectors:[],polygon:[],expiresAt:expiry,displayPolicy:'google_map_only' };
const data: any = { snapshotId:SNAP,envelope,cards:[{id:'c',title:'Garden',routing:{state:'FEASIBLE',band:'SAFE',reason:null,absence:null,outboundMinutes:5,conservativeReturnMinutes:10,returnContract:null,expiresAt:expiry,geometry:{outbound:line,returnLeg:line}}}] };
const props = {data,currentSnapshotId:SNAP,selectedIds:['c'],airport:{lat:1.3,lng:103.9,iataCode:'SIN'},nowMs:NOW};
const topology = { available:true,reason:null,source:'published_airport_topology',displayPolicy:'independent_map',cachePolicy:'until_expiry',factId:'f',topologyVersion:2,expiresAt:expiry,
  features:[{id:'t1',kind:'terminal',label:'Terminal 1',terminalId:'T1',minutes:null,geometry:{type:'Point',coordinates:[103.9,1.3]}}] };
beforeEach(()=>{ jest.spyOn(UIManager,'getViewManagerConfig').mockReturnValue({ Commands: {} }); }); afterEach(async()=>{ jest.restoreAllMocks(); await AsyncStorage.clear(); (Constants.expoConfig!.extra!.layoverGoogleMap as any).ios=true; });
test('native routes use Google provider and line taps show the actual return destination',async()=>{
  await render(<LayoverGoogleRouteMap {...props}/>);
  expect(screen.getByTestId('native-map-google')).toBeTruthy(); expect(screen.getAllByTestId('provider-polyline')).toHaveLength(2);
  await fireEvent.press(screen.getAllByTestId('provider-polyline')[1]!); expect(screen.getByText('Return from Garden')).toBeTruthy();
});
test('no configured native key gives a named fallback without mounting a map',async()=>{
  (Constants.expoConfig!.extra!.layoverGoogleMap as any).ios=false;
  await render(<LayoverGoogleRouteMap {...props}/>); expect(screen.getByTestId('layover-google-map-unavailable')).toBeTruthy(); expect(screen.queryByTestId('native-map-google')).toBeNull();
});
test('offline and expired answers do not mount provider geometry',async()=>{
  const r=await render(<LayoverGoogleRouteMap {...props} offline/>); expect(screen.queryByTestId('native-map-google')).toBeNull();
  await r.rerender(<LayoverGoogleRouteMap {...props} nowMs={NOW+300000}/>); expect(screen.queryByTestId('native-map-google')).toBeNull();
});
test('a build with credentials but without the native Google map manager fails visibly',async()=>{
  jest.mocked(UIManager.getViewManagerConfig).mockImplementation(()=>{ throw new Error('native Google map manager not linked'); }); await render(<LayoverGoogleRouteMap {...props}/>);
  expect(screen.getByTestId('layover-google-map-unavailable')).toBeTruthy(); expect(screen.queryByTestId('native-map-google')).toBeNull();
});
test('Google-derived sampled envelope never mounts on the independent MapLibre source',async()=>{
  await render(<LayoverRoutedMapLayer data={data} currentSnapshotId={SNAP} nowMs={NOW}/>); expect(screen.queryByTestId('layover-routed-source')).toBeNull();
});
test('native airport geometry selection opens sourced details; expiry removes the geographic layer',async()=>{
  const r=await render(<LayoverAirportLayout geometry={topology} nowMs={NOW}/>);
  await fireEvent.press(screen.getByLabelText('Airport layout')); await fireEvent.press(screen.getByText('Tap source feature'));
  expect(screen.getByTestId('layover-airport-layout-selection')).toHaveTextContent('Terminal 1 · terminal · no walking time stated');
  await r.rerender(<LayoverAirportLayout geometry={topology} nowMs={NOW+300000}/>); expect(screen.queryByTestId('layover-airport-topology')).toBeNull();
});
test('real AsyncStorage cache removes restricted coordinates and retains independently sourced airport layout',async()=>{
  const bundle:any={sessionId:'s',bundleVersion:'1',certifiedAt:new Date(NOW).toISOString(),staleAfter:expiry,airport:{iataCode:'SIN',name:'Airport',city:'Singapore',timezone:'Asia/Singapore',lat:1.3,lng:103.9,topologyGeometry:topology},stops:[]};
  expect(await cacheCertifiedPlan('s',bundle,null,null,data)).toBe(true);
  const saved=await readCachedPlan('s'); expect(saved?.routedMap?.envelope).toBeNull(); expect(saved?.routedMap?.cards[0]?.routing.geometry?.returnLeg).toBeNull();
  expect(saved?.airport.topologyGeometry?.features[0]?.label).toBe('Terminal 1');
  const all=JSON.stringify(await AsyncStorage.multiGet(await AsyncStorage.getAllKeys())); expect(all).not.toContain('LineString');
});
