/**
 * Avatar primitives draw Portava storage or nothing (lane PRIV-FIX-3;
 * census-telegraph §97).
 *
 * A person's avatar is drawn by every viewer of that person. Before this change
 * each primitive handed whatever `avatarUrl` the API returned straight to the
 * image loader — the hydration layer passes a non-storage URL through unchanged —
 * so a person who set their avatar to a host they control learned every
 * viewer's address and the moment they looked. Every primitive below now drops
 * a non-storage avatar BEFORE hydration and draws its designed no-photo state.
 *
 * Covered: ui/Avatar, AvatarImage (by `uri` and by `user.avatarUrl`), the
 * components/ui.tsx Avatar, UserAvatarButton, TelegraphAvatar, and the reader
 * chips' faces (useReaderAvatars). Each has a CONTROL: a Portava storage
 * reference is still drawn.
 *
 * Uses react-test-renderer for prop inspection (RNTL v14 dropped UNSAFE_getAllByType).
 */
import React from 'react';
import { Image as RNImage, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { Avatar } from '../Avatar.tsx';
import { AvatarImage } from '../DisplayMediaImage.tsx';
import { Avatar as LegacyAvatar } from '../../ui.tsx';
import { UserAvatarButton } from '../../interaction/UserAvatarButton.tsx';
import { TelegraphAvatar } from '../../telegraph/TelegraphPrimitives.tsx';
import { useReaderAvatars } from '../../../features/telegraph/lifecycle/useReaderAvatars.ts';
import { publishReaderFaces, _resetReaderFaces } from '../../../features/telegraph/lifecycle/readerFaces.ts';

// ── mediaUrl mock: hydration passes every URL through, as the real layer does for a non-storage URL ──
// NOTE: intentionally exhaustive — mediaUrl.ts imports React hooks and batchSignMedia at module level;
// spreading requireActual would trigger fetch/network calls in JSDOM.
jest.mock('../../../services/mediaUrl.ts', () => {
  const React = require('react');
  return {
    PRIVATE_BUCKETS: ['post-media', 'profile-media'],
    hydrateMediaUrls: async (urls: string[]) => Object.fromEntries(urls.map((u) => [u, u])),
    isPrivateMediaRef: () => false,
    useHydratedMedia: (urls: (string | null | undefined)[]) => {
      const resolved = React.useMemo(
        () => Object.fromEntries(urls.filter((u): u is string => !!u).map((u) => [u, u])),
        [urls.join('\0')], // eslint-disable-line react-hooks/exhaustive-deps
      );
      return { resolved, loading: false };
    },
  };
});

jest.mock('../../../lib/batchSignMedia.ts', () => ({
  ...jest.requireActual('../../../lib/batchSignMedia.ts'),
  _evictBatchSignEntry: () => {},
}));

jest.mock('expo-image', () => {
  const React = require('react');
  const { View } = require('react-native');
  function MockExpoImage({ source }: any) {
    return <View testID="mock-expo-image" {...{ 'data-source': JSON.stringify(source ?? null) }} />;
  }
  MockExpoImage.displayName = 'MockExpoImage';
  return { Image: MockExpoImage };
});

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), navigate: jest.fn() },
}));

const FOREIGN = 'https://tracker.example/p.gif?u=viewer';
const STORED = 'profile-media/avatars/aa000000-0000-4000-a000-000000000099/1b9d6bcd.jpg';

function create(el: React.ReactElement) {
  let tr!: TestRenderer.ReactTestRenderer;
  act(() => { tr = TestRenderer.create(el); });
  return tr;
}

/** Every image source the tree mounted: expo-image (mocked) and react-native Image. */
function mountedSources(tr: TestRenderer.ReactTestRenderer): string[] {
  const out: string[] = [];
  for (const n of tr.root.findAll((x) => x.props?.testID === 'mock-expo-image' && typeof x.props['data-source'] === 'string')) {
    out.push(String(n.props['data-source']));
  }
  for (const n of tr.root.findAllByType(RNImage as any)) out.push(JSON.stringify(n.props.source ?? null));
  return [...new Set(out)];
}

const texts = (tr: TestRenderer.ReactTestRenderer) => tr.root.findAllByType(Text as any).map((n) => String(n.props.children));

const PRIMITIVES: Array<[string, (uri: string) => React.ReactElement]> = [
  ['ui/Avatar', (uri) => <Avatar uri={uri} name="Maya Chen" />],
  ['AvatarImage (uri)', (uri) => <AvatarImage uri={uri} user={{ displayName: 'Maya Chen' }} size={36} />],
  ['AvatarImage (user.avatarUrl)', (uri) => <AvatarImage user={{ displayName: 'Maya Chen', avatarUrl: uri }} size={36} />],
  ['components/ui.tsx Avatar', (uri) => <LegacyAvatar uri={uri} user={{ displayName: 'Maya Chen' }} />],
  ['UserAvatarButton', (uri) => <UserAvatarButton userId="u-1" handle="maya" avatarUrl={uri} />],
  ['TelegraphAvatar', (uri) => <TelegraphAvatar uri={uri} name="Maya" />],
];

describe('§97 an avatar primitive never hands an outside host to the image loader', () => {
  for (const [name, el] of PRIMITIVES) {
    it(`${name}: an outside avatar is not mounted; the no-photo state is drawn`, () => {
      const tr = create(el(FOREIGN));
      const sources = mountedSources(tr);
      assert(sources.every((s) => !s.includes('tracker.example')), `${name} mounted ${JSON.stringify(sources)}`);
      assert(sources.every((s) => s === 'null'), `${name} mounted an image at all: ${JSON.stringify(sources)}`);
      // The designed fallback: initials (or the initial), never an empty circle.
      const t = texts(tr).join(' ');
      assert(/M/.test(t) || name === 'ui/Avatar', `${name} drew no initials: ${t}`);
      if (name === 'ui/Avatar') expect(tr.root.findAll((x) => x.props?.accessibilityLabel === 'Maya Chen, person').length).toBeGreaterThan(0);
    });
    it(`${name}: CONTROL — a Portava storage reference is still drawn`, () => {
      const tr = create(el(STORED));
      const sources = mountedSources(tr);
      assert(sources.some((s) => s.includes(STORED)), `${name} did not draw a storage avatar: ${JSON.stringify(sources)}`);
    });
  }
});

describe('§97 the reader chips: a face the server answered is drawn only when it is Portava storage', () => {
  function Faces({ ids }: { ids: string[] }) {
    const face = useReaderAvatars(ids);
    return <>{ids.map((id) => <Text key={id}>{`${id}=${face(id) ?? 'none'}`}</Text>)}</>;
  }
  afterEach(() => { act(() => _resetReaderFaces()); });
  it('an outside face is withheld, a storage face is kept', () => {
    act(() => publishReaderFaces({ a: FOREIGN, b: STORED }));
    const tr = create(<Faces ids={['a', 'b']} />);
    expect(texts(tr)).toEqual(['a=none', `b=${STORED}`]);
  });
});

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
