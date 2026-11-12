import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { InboxFollowingHighlights } from '../inbox/InboxFollowingHighlights.tsx';
const mockFeed = jest.fn();
const mockViewer = jest.fn();
let mockActive = true;
// NOTE: The following-feed API response supplies this inbox lifecycle fixture.
jest.mock('../../../services/highlights.ts', () => ({fetchFollowingHighlightsFeed: (...args: unknown[]) => mockFeed(...args)}));
// NOTE: Focus is toggled explicitly so a pending response can finish after blur.
jest.mock('../../../hooks/useMediaSurfaceActivity.ts', () => ({useMediaSurfaceActivity: () => ({active: mockActive, epoch:0})}));
// NOTE: The test has one fixed authenticated session.
jest.mock('../../../hooks/usePrivateSurfaceKey.ts', () => ({usePrivateSurfaceKey: () => 'session'}));
// NOTE: Viewed marks are isolated from device storage in this feed test.
jest.mock('../../../hooks/useHighlightRingState.ts', () => ({viewedHighlightIds:new Set(),markViewed:jest.fn()}));
// NOTE: The fixture's authenticated viewer is fixed.
jest.mock('../../../context/SessionContext.tsx', () => ({useSession: () => ({userId:'viewer'})}));
// NOTE: The existing viewer is exercised separately; this checks which authorized list it receives.
jest.mock('../../../components/HighlightViewer.tsx', () => ({HighlightViewer: (p: unknown) => {mockViewer(p);return null;}}));
// NOTE: Media hydration has independent tests; this fixture observes which source the card passes.
jest.mock('../../../components/ui/DisplayMediaImage.tsx', () => ({DisplayMediaImage: () => null}));
// NOTE: Post-reference media hydration is outside the feed ordering test.
jest.mock('../../../components/PostReferenceCard.tsx', () => ({PostReferenceCover: () => null}));
const entry=(userId:string,expiresAt:string|null=null) => ({userId,handle:userId,name:userId,avatarUrl:null,highlights:[{id:`h-${userId}`,mediaType:'image/jpeg',mediaUrl:null,expiresAt,viewedByMe:false}]});
beforeEach(() => {mockActive=true;mockFeed.mockReset();mockViewer.mockReset();});
it('shows server-ordered followed authors, skips self, blocks and expired highlights, and opens their viewer', async () => {
  mockFeed.mockResolvedValue({ok:true,data:[entry('b'),entry('viewer'),entry('blocked'),entry('expired','2020-01-01'),entry('a')],nextCursor:null});
  const ui=await render(<InboxFollowingHighlights viewerId="viewer" excluded={new Set(['blocked'])}/>);
  expect(ui.getAllByRole('button').map(x=>x.props.accessibilityLabel)).toEqual(["View b's highlights", "View a's highlights"]);
  await fireEvent.press(ui.getByLabelText("View b's highlights"));
  expect(mockViewer.mock.calls.at(-1)![0]).toMatchObject({highlights:[expect.objectContaining({id:'h-b'})]});
  await act(async()=>mockViewer.mock.calls.at(-1)![0].onClose());
  expect(mockFeed).toHaveBeenCalledTimes(2);
});
it('rechecks after returning, hides an empty strip, and discards a retired pending read', async () => {
  let finish!: (result:any)=>void;
  mockFeed.mockReturnValueOnce(new Promise(resolve=>{finish=resolve})).mockResolvedValue({ok:true,data:[],nextCursor:null});
  const props={viewerId:'viewer',excluded:new Set<string>()};
  const ui=await render(<InboxFollowingHighlights {...props}/>);
  mockActive=false;await ui.rerender(<InboxFollowingHighlights {...props}/>);
  mockActive=true;await ui.rerender(<InboxFollowingHighlights {...props}/>);
  await act(async()=>finish({ok:true,data:[entry('old')],nextCursor:null}));
  expect(mockFeed).toHaveBeenCalledTimes(2);
  expect(ui.queryByRole('button')).toBeNull();
});
