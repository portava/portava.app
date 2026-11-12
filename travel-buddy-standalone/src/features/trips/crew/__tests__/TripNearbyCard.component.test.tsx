import React from'react';
import{AppState}from'react-native';
import{act,fireEvent,render,screen,waitFor}from'@testing-library/react-native';
import{TripNearbyCard}from'../TripNearbyCard.tsx';
const mockAvailable=jest.fn(),mockCapabilities=jest.fn(),mockStart=jest.fn(),mockStop=jest.fn();
let mockRuns:Array<{options:any;run:any}>=[];
let mockFocusCleanup:(()=>void)|undefined;
const mockOwner={ownerId:'owner',sessionId:'session',isCurrent:()=>true,invalidate:()=>{}};
// NOTE: isolated external native/auth/network seam; this fixture supplies exactly the exports used by the mounted card or controller.
jest.mock('../../../../services/tripNearby.ts',()=>({nearbyAvailable:(...a:any[])=>mockAvailable(...a)}));
// NOTE: isolated external native/auth/network seam; this fixture supplies exactly the exports used by the mounted card or controller.
jest.mock('../../../../services/tripNearbyNative.ts',()=>({tripNearbyNative:{capabilities:(...a:any[])=>mockCapabilities(...a)}}));
// NOTE: isolated external native/auth/network seam; this fixture supplies exactly the exports used by the mounted card or controller.
jest.mock('../../../../services/tripNearbyRun.ts',()=>({createTripNearbyRun:(options:any)=>{const run={start:mockStart,stop:mockStop};mockRuns.push({options,run});return run;}}));
// NOTE: isolated external native/auth/network seam; this fixture supplies exactly the exports used by the mounted card or controller.
jest.mock('../../../../services/messagingOwnerRequest.ts',()=>({captureMessagingOwnerRequest:()=>mockOwner}));
// NOTE: isolated external native/auth/network seam; this fixture supplies exactly the exports used by the mounted card or controller.
jest.mock('../../../../services/postDestinations.ts',()=>({newPostDestinationOperation:()=> '22222222-2222-4222-8222-222222222222'}));
// NOTE: isolated external native/auth/network seam; this fixture supplies exactly the exports used by the mounted card or controller.
jest.mock('../../../../hooks/usePrivateSurfaceKey.ts',()=>({usePrivateSurfaceKey:()=> 'owner-scope'}));
// NOTE: isolated external native/auth/network seam; this fixture supplies exactly the exports used by the mounted card or controller.
jest.mock('expo-router',()=>({useFocusEffect:(cb:()=>void|(()=>void))=>{const React=jest.requireActual('react');React.useEffect(()=>{mockFocusCleanup=cb() as()=>void;return()=>mockFocusCleanup?.();},[cb]);}}));
beforeEach(()=>{jest.clearAllMocks();mockRuns=[];mockAvailable.mockResolvedValue(true);mockCapabilities.mockResolvedValue({supported:true,permissionsGranted:false});mockStart.mockResolvedValue(undefined);mockStop.mockResolvedValue(undefined);Object.defineProperty(AppState,'currentState',{configurable:true,value:'active'});});
test('mounted card requires the explicit opt-in and still allows the first OS permission request',async()=>{
 const view=await await render(<TripNearbyCard tripId="11111111-1111-4111-8111-111111111111"/>);
 await screen.findByText('Opt in for 5 minutes');expect(mockStart).not.toHaveBeenCalled();fireEvent.press(screen.getByText('Opt in for 5 minutes'));await waitFor(()=>expect(mockStart).toHaveBeenCalledTimes(1));await view.unmount();expect(mockStop).toHaveBeenCalled();
});
test('leaving the focused screen stops the scoped session',async()=>{
 await render(<TripNearbyCard tripId="11111111-1111-4111-8111-111111111111"/>);await screen.findByText('Opt in for 5 minutes');fireEvent.press(screen.getByText('Opt in for 5 minutes'));await waitFor(()=>expect(mockStart).toHaveBeenCalled());await act(async()=>mockFocusCleanup?.());expect(mockStop).toHaveBeenCalled();
});
test('disabled availability or Ghost Mode cannot start Bluetooth',async()=>{
 mockAvailable.mockResolvedValue(false);const view=await await render(<TripNearbyCard tripId="11111111-1111-4111-8111-111111111111"/>);await screen.findByText('Nearby Bluetooth is not available for this trip or app build.');expect(screen.queryByText('Opt in for 5 minutes')).toBeNull();await view.rerender(<TripNearbyCard tripId="11111111-1111-4111-8111-111111111111" hidden/>);expect(screen.getByText('Nearby sharing is off while Ghost Mode is on.')).toBeTruthy();expect(mockStart).not.toHaveBeenCalled();
});

test('callbacks from a replaced controller cannot clear the current session or overwrite its state',async()=>{
 const view=await render(<TripNearbyCard tripId="11111111-1111-4111-8111-111111111111"/>);
 await screen.findByText('Opt in for 5 minutes');await fireEvent.press(screen.getByText('Opt in for 5 minutes'));await waitFor(()=>expect(mockRuns).toHaveLength(1));
 await act(async()=>mockRuns[0].options.onState('active'));
 await fireEvent.press(screen.getByText('Stop nearby sharing'));
 await act(async()=>mockRuns[0].options.onState('stopped'));
 await fireEvent.press(screen.getByText('Opt in for 5 minutes'));await waitFor(()=>expect(mockRuns).toHaveLength(2));
 await act(async()=>{mockRuns[1].options.onState('active');mockRuns[1].options.onPeers([{userId:'peer',handle:'current-peer',proximity:'nearby',observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+30000).toISOString()}]);});
 await act(async()=>{mockRuns[0].options.onState('unavailable','Old request failed');mockRuns[0].options.onPeers([]);});
 expect(screen.getByText('Stop nearby sharing')).toBeTruthy();expect(screen.queryByText('Old request failed')).toBeNull();expect(screen.getByText(/current-peer/)).toBeTruthy();await view.unmount();
});
