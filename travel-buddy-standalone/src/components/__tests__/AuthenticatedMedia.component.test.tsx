import React from 'react';
import { View } from 'react-native';
import { act, render, screen } from '@testing-library/react-native';
import { CachedImage } from '../CachedImage.tsx';
import { useMediaRequestSource } from '../../hooks/useMediaRequestSource.ts';
import { notifyMediaCredentialsChanged } from '../../hooks/useMediaScopeKey.ts';
import { resolveMediaRequestSources } from '../../services/mediaRequestSource.ts';
import { currentDiscoveryScope, invalidateDiscoveryCaches, setDiscoveryViewerFromSession } from '../../services/discoveryViewerScope.ts';

const OWNER = 'a1000000-0000-4000-a000-000000000002';
const OTHER = 'a1000000-0000-4000-a000-000000000003';
const URI = `https://rumazi.com/api/media/file/post-media/${OWNER}/photo.jpg?viewer=${OWNER}`;
const jwt = (viewer: string) => `e30.${btoa(JSON.stringify({ sub: viewer }))}.c2ln`;
let mockToken: () => Promise<string | null>;
jest.mock('../../services/apiToken.ts', () => ({
  ...jest.requireActual('../../services/apiToken.ts'),
  freshToken: () => mockToken(),
  isCurrentSessionToken: async () => true,
}));
jest.mock('expo-image', () => ({ ...jest.requireActual('expo-image'), Image: (props: unknown) => require('react').createElement(require('react-native').View, props) }));
jest.mock('../ui/DisplayMediaImage.tsx', () => ({ ...jest.requireActual('../ui/DisplayMediaImage.tsx'), MediaFallback: () => null }));

function PlayerSource() {
  const source = useMediaRequestSource(URI);
  return <View testID="player" accessibilityValue={{ text: JSON.stringify(source) }} />;
}
async function flush() {
  await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
}
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://rumazi.com';
  setDiscoveryViewerFromSession(OWNER);
  mockToken = async () => jwt(OWNER);
});

it('resolves the real source service with the session fixture', async () => {
  expect((await resolveMediaRequestSources({ image: URI })).image).toEqual({ uri: URI, headers: { Authorization: `Bearer ${jwt(OWNER)}` } });
});
afterEach(() => {
  jest.useRealTimers();
  setDiscoveryViewerFromSession(null);
  if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
});

it('does not mount a relay image before authentication and passes headers without persistent image caching', async () => {
  let release!: (token: string) => void;
  mockToken = () => new Promise(resolve => { release = resolve; });
  await render(<CachedImage source={{ uri: URI }} testID="image" />);
  await flush();
  expect(screen.getByTestId('image').props.source).toBeUndefined();
  await act(async () => { release(jwt(OWNER)); });
  await flush();
  const image = screen.getByTestId('image');
  expect(image.props.source).toEqual({ uri: URI, headers: { Authorization: `Bearer ${jwt(OWNER)}` } });
  expect(image.props.cachePolicy).toBe('none');
  expect(image.props.source.uri).not.toContain(jwt(OWNER));
});

it('removes a mounted image when permission scope changes and discards a delayed old-account source', async () => {
  await render(<CachedImage source={{ uri: URI }} testID="image" />);
  await flush();
  expect(screen.getByTestId('image').props.source.headers).toBeDefined();
  let release!: (token: string) => void;
  mockToken = () => new Promise(resolve => { release = resolve; });
  await act(async () => { invalidateDiscoveryCaches(); });
  await flush();
  expect(screen.getByTestId('image').props.source).toBeUndefined();
  const oldRelease = release;
  await act(async () => { setDiscoveryViewerFromSession(OTHER); });
  await flush();
  await act(async () => { oldRelease(jwt(OWNER)); release(jwt(OTHER)); });
  await flush();
  expect(screen.getByTestId('image').props.source).toBeUndefined();
});

it('provides native video fallback headers and removes the source on account change', async () => {
  await render(<PlayerSource />);
  await flush();
  expect(JSON.parse(screen.getByTestId('player').props.accessibilityValue.text)).toEqual({ uri: URI, headers: { Authorization: `Bearer ${jwt(OWNER)}` } });
  mockToken = async () => jwt(OTHER);
  await act(async () => { setDiscoveryViewerFromSession(OTHER); });
  await flush();
  expect(JSON.parse(screen.getByTestId('player').props.accessibilityValue.text)).toBeNull();
});

it('replaces image and native fallback headers on same-user refresh without moving Discovery scope', async () => {
  await render(<><CachedImage source={{ uri: URI }} testID="image" /><PlayerSource /></>);
  await flush();
  const scope = currentDiscoveryScope();
  const refreshed = `${jwt(OWNER)}-refreshed`;
  mockToken = async () => refreshed;
  await act(async () => { notifyMediaCredentialsChanged(); });
  await flush();
  expect(screen.getByTestId('image').props.source.headers.Authorization).toBe(`Bearer ${refreshed}`);
  expect(JSON.parse(screen.getByTestId('player').props.accessibilityValue.text).headers.Authorization).toBe(`Bearer ${refreshed}`);
  expect(currentDiscoveryScope()).toEqual(scope);
  await act(async () => { setDiscoveryViewerFromSession(null); });
  await flush();
  expect(screen.getByTestId('image').props.source).toBeUndefined();
  expect(JSON.parse(screen.getByTestId('player').props.accessibilityValue.text)).toBeNull();
});

it('withholds a relay image if session token validation fails', async () => {
  mockToken = async () => null;
  await render(<CachedImage source={{ uri: URI }} testID="image" />);
  await flush();
  expect(screen.getByTestId('image').props.source).toBeUndefined();
});

it('bounds a stalled token refresh and releases a pending source on account change', async () => {
  jest.useFakeTimers();
  mockToken = () => new Promise(() => {});
  const timeout = resolveMediaRequestSources({ image: URI });
  await jest.advanceTimersByTimeAsync(10_000);
  expect(await timeout).toEqual({ image: null });
  const cancelled = resolveMediaRequestSources({ image: URI });
  setDiscoveryViewerFromSession(OTHER);
  expect(await cancelled).toEqual({ image: null });
  expect(jest.getTimerCount()).toBe(0);
});
