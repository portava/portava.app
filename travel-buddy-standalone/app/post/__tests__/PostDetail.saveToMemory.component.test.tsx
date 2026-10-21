/**
 * MD385 — the entry point: the post detail overflow offers "Save to a Memory"
 * ONLY on the viewer's own post with media, and ONLY while
 * `memory_from_own_media_enabled` is on (seeded FALSE: nothing shows).
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';

let mockUserId: string | null = 'me';
let mockFlags: Record<string, boolean> = {};

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const react = jest.requireActual('react');
  const modal = ({ visible, children }: { visible: boolean; children: React.ReactNode }) => (visible ? react.createElement(actual.View, null, children) : null);
  return new Proxy(actual, { get(target, property, receiver) { return property === 'Modal' ? modal : Reflect.get(target, property, receiver); } });
});
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useLocalSearchParams: () => ({ id: 'post-1' }),
  useFocusEffect: (effect: () => void | (() => void)) => { jest.requireActual('react').useEffect(effect, [effect]); },
  router: { ...jest.requireActual('expo-router').router, push: jest.fn(), back: jest.fn() },
}));
jest.mock('../../../src/context/SessionContext.tsx', () => ({
  ...jest.requireActual('../../../src/context/SessionContext.tsx'),
  useSession: () => ({ userId: mockUserId, isAuthed: Boolean(mockUserId), configured: true }),
}));
jest.mock('../../../src/context/FeatureFlagsContext.tsx', () => ({
  ...jest.requireActual('../../../src/context/FeatureFlagsContext.tsx'),
  useFeatureFlags: () => ({ isEnabled: (k: string) => mockFlags[k] === true, isLivePlacesEnabled: () => false, loading: false }),
}));
jest.mock('../../../src/context/LanguagePreferenceContext.tsx', () => ({
  ...jest.requireActual('../../../src/context/LanguagePreferenceContext.tsx'),
  useLanguagePreference: () => ({ ...jest.requireActual('../../../src/context/LanguagePreferenceContext.tsx').useLanguagePreference(), preferredLanguage: null, loading: false }),
}));
jest.mock('../../../src/services/posts.ts', () => ({
  ...jest.requireActual('../../../src/services/posts.ts'),
  getPostById: jest.fn(),
}));
jest.mock('../../../src/services/memories.ts', () => ({
  ...jest.requireActual('../../../src/services/memories.ts'),
  getUserMemories: jest.fn(async () => ({ ok: true, memories: [], nextCursor: null })),
}));
jest.mock('../../../src/hooks/useNavBarCollapse.ts', () => ({
  ...jest.requireActual('../../../src/hooks/useNavBarCollapse.ts'),
  NavBarFiller: () => null,
  useNavBarScrollHandler: () => () => {},
}));
jest.mock('../../../src/components/CommentsSheet.tsx', () => ({ ...jest.requireActual('../../../src/components/CommentsSheet.tsx'), CommentsSection: () => null }));
jest.mock('../../../src/components/ReportSheet.tsx', () => ({ ...jest.requireActual('../../../src/components/ReportSheet.tsx'), ReportSheet: () => null }));
jest.mock('../../../src/components/PostWrongPlaceSheet.tsx', () => ({ ...jest.requireActual('../../../src/components/PostWrongPlaceSheet.tsx'), PostWrongPlaceSheet: () => null }));
jest.mock('../../../src/components/TranslatedContent.tsx', () => ({
  ...jest.requireActual('../../../src/components/TranslatedContent.tsx'),
  TranslatedContent: ({ text }: { text?: string }) => jest.requireActual('react').createElement(jest.requireActual('react-native').Text, null, text ?? ''),
}));
jest.mock('../../../src/components/StampOverlayBadge.tsx', () => ({ ...jest.requireActual('../../../src/components/StampOverlayBadge.tsx'), MediaStampOverlay: () => null }));
jest.mock('../../../src/components/ui/SharedVideoPlayer.tsx', () => ({ ...jest.requireActual('../../../src/components/ui/SharedVideoPlayer.tsx'), SharedVideoPlayer: () => null }));
jest.mock('../../../src/components/ui/DisplayMediaImage.tsx', () => ({
  ...jest.requireActual('../../../src/components/ui/DisplayMediaImage.tsx'),
  AvatarImage: () => null,
  DisplayMediaImage: () => null,
}));
jest.mock('../../../src/components/ui/KeyboardSafeView.tsx', () => ({
  ...jest.requireActual('../../../src/components/ui/KeyboardSafeView.tsx'),
  KeyboardSafeScrollView: ({ children }: { children: React.ReactNode }) => children,
}));

import PostDetail from '../[id].tsx';
import { getPostById, type PostRow } from '../../../src/services/posts.ts';

const FLAG = 'memory_from_own_media_enabled';
const post = (over: Partial<PostRow> = {}): PostRow => ({
  id: 'post-1', authorId: 'me', tripId: null, content: 'Sunset', mediaUrls: ['https://x/a.jpg'], media: [],
  visibility: 'public', status: 'active', createdAt: '2026-10-16T10:00:00Z', updatedAt: '2026-10-16T10:00:00Z',
  author: { id: 'me', handle: 'me', name: 'Me', avatarUrl: null },
  likeCount: 0, stampCount: 0, commentCount: 0, shareCount: 0, likedByMe: false, savedByMe: false,
  saveCount: 0, canLike: true, canComment: true, canShare: true,
  filterId: 'original', filterIntensity: 0, tags: [], hashtagUsages: [], ...over,
} as PostRow);

async function openOverflow(p: PostRow) {
  jest.mocked(getPostById).mockResolvedValue({ ok: true, data: p } as any);
  await render(<PostDetail />);
  await act(async () => {});
  await act(async () => { fireEvent.press(screen.getAllByLabelText('More options')[0]); });
}

beforeEach(() => { mockUserId = 'me'; mockFlags = {}; jest.mocked(getPostById).mockReset(); });
afterEach(async () => { await cleanup(); });

describe('post detail — "Save to a Memory"', () => {
  it('flag OFF (the seeded default): nothing shows, even on my own post with a photo', async () => {
    await openOverflow(post());
    expect(screen.getByText('Share post')).toBeTruthy();
    expect(screen.queryByTestId('overflow-save-to-memory')).toBeNull();
  });

  it('flag ON, my own post with a photo: offered, and it opens the sheet', async () => {
    mockFlags = { [FLAG]: true };
    await openOverflow(post());
    expect(screen.getByTestId('overflow-save-to-memory')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByTestId('overflow-save-to-memory')); });
    expect(screen.getByTestId('save-to-memory-sheet')).toBeTruthy();
  });

  it('flag ON, someone else\'s post: not offered', async () => {
    mockFlags = { [FLAG]: true };
    await openOverflow(post({ authorId: 'other', author: { id: 'other', handle: 'o', name: 'O', avatarUrl: null } } as any));
    expect(screen.queryByTestId('overflow-save-to-memory')).toBeNull();
  });

  it('flag ON, my own post with no photo or video: not offered', async () => {
    mockFlags = { [FLAG]: true };
    await openOverflow(post({ mediaUrls: [] }));
    expect(screen.queryByTestId('overflow-save-to-memory')).toBeNull();
  });

  it('flag ON, signed out: not offered', async () => {
    mockFlags = { [FLAG]: true };
    mockUserId = null;
    await openOverflow(post());
    expect(screen.queryByTestId('overflow-save-to-memory')).toBeNull();
  });
});
