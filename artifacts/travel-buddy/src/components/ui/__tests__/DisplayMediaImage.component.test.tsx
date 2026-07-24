/**
 * DisplayMediaImage / AvatarImage component tests
 *
 * Covers:
 *   - null URL → fallback rendered immediately
 *   - broken URL via onError callback → fallback
 *   - valid URL → image rendered (not fallback)
 *   - AvatarImage null user → initials fallback
 *   - AvatarImage broken URL → initials fallback (via onError)
 *   - AvatarImage valid URL → image rendered, no initials
 *
 * Uses react-test-renderer (not RNTL) for prop inspection and callback
 * triggering — RNTL v14 dropped UNSAFE_getAllByType. This matches the
 * KeyboardSafeView test pattern already in this project.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { DisplayMediaImage, AvatarImage } from '../DisplayMediaImage.tsx';
import * as MediaSourceModule from '../../../lib/mediaSource.ts';

// ── mediaSource mock ─────────────────────────────────────────────────────────
// Default: flag-OFF fast path — returns { uri } unchanged.
// Individual tests override this to simulate flag-ON relay behaviour.

const mockMediaSource = jest.fn(async (url: string | null | undefined) =>
  url ? { uri: url } : { uri: '' },
);

jest.mock('../../../lib/mediaSource.ts', () => ({
  ...jest.requireActual('../../../lib/mediaSource.ts'),
  mediaSource: (...args: any[]) => mockMediaSource(...args),
}));

// ── expo-image mock ──────────────────────────────────────────────────────────

jest.mock('expo-image', () => {
  const React = require('react');
  const { View } = require('react-native');
  // Named export "Image" — accepts onError/onLoad so we can call them in tests.
  function MockExpoImage({ onError, onLoad, accessibilityLabel, testID, source }: any) {
    return (
      <View
        testID={testID ?? 'mock-expo-image'}
        accessibilityLabel={accessibilityLabel}
        // Store callbacks on the node so TestRenderer can inspect them.
        onLayout={undefined}
        // Custom data props for test inspection (camelCase to avoid RN warnings)
        {...{
          'data-on-error': onError,
          'data-on-load': onLoad,
          // Serialise source so tests can verify relay URL + headers.
          'data-source': JSON.stringify(source ?? null),
        }}
      />
    );
  }
  MockExpoImage.displayName = 'MockExpoImage';
  return { Image: MockExpoImage };
});

jest.mock('expo-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    LinearGradient: ({ children, ...rest }: any) =>
      React.createElement(View, rest, children),
  };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function findExpoImages(root: TestRenderer.ReactTestInstance) {
  try {
    return root.findAllByProps({ testID: 'mock-expo-image' });
  } catch {
    return [];
  }
}

function fireOnError(root: TestRenderer.ReactTestInstance) {
  const imgs = findExpoImages(root);
  if (imgs.length === 0) throw new Error('No mock expo-image found');
  const cb = imgs[0].props['data-on-error'];
  if (typeof cb !== 'function') throw new Error('No data-on-error prop found');
  act(() => cb());
}

function fireOnLoad(root: TestRenderer.ReactTestInstance) {
  const imgs = findExpoImages(root);
  if (imgs.length === 0) throw new Error('No mock expo-image found');
  const cb = imgs[0].props['data-on-load'];
  if (typeof cb !== 'function') throw new Error('No data-on-load prop found');
  act(() => cb());
}

function create(el: React.ReactElement) {
  let tr!: TestRenderer.ReactTestRenderer;
  act(() => { tr = TestRenderer.create(el); });
  return tr;
}

function textContent(root: TestRenderer.ReactTestInstance): string[] {
  return root.findAllByType(Text as any).map((n) => n.props.children as string);
}

// ── DisplayMediaImage ────────────────────────────────────────────────────────

describe('DisplayMediaImage', () => {
  it('renders fallback label immediately when uri is null', () => {
    const tr = create(
      <DisplayMediaImage uri={null} width={100} height={100} fallbackLabel="No image" />,
    );
    expect(textContent(tr.root)).toContain('No image');
    // No expo-image should be mounted
    expect(findExpoImages(tr.root).length).toBe(0);
  });

  it('renders fallback label when uri is empty string', () => {
    const tr = create(
      <DisplayMediaImage uri="" width={100} height={100} fallbackLabel="Empty" />,
    );
    expect(textContent(tr.root)).toContain('Empty');
  });

  it('renders custom fallback node when uri is null', () => {
    const tr = create(
      <DisplayMediaImage
        uri={null}
        width={100}
        height={100}
        fallback={<Text>Custom node</Text>}
      />,
    );
    expect(textContent(tr.root)).toContain('Custom node');
  });

  it('mounts expo-image (not fallback) while loading a valid url', () => {
    const tr = create(
      <DisplayMediaImage
        uri="https://example.com/ok.jpg"
        width={100}
        height={100}
        fallbackLabel="Should not appear"
      />,
    );
    // Fallback label not shown while loading
    expect(textContent(tr.root)).not.toContain('Should not appear');
    // expo-image is mounted
    expect(findExpoImages(tr.root).length).toBeGreaterThan(0);
  });

  it('switches to fallback after onError fires', () => {
    const tr = create(
      <DisplayMediaImage
        uri="https://example.com/broken.jpg"
        width={100}
        height={100}
        fallbackLabel="Broken"
      />,
    );
    // Not shown before error
    expect(textContent(tr.root)).not.toContain('Broken');

    fireOnError(tr.root);

    // Now the fallback label is shown
    expect(textContent(tr.root)).toContain('Broken');
    // expo-image is unmounted (error phase)
    expect(findExpoImages(tr.root).length).toBe(0);
  });

  it('passes alt as accessibilityLabel to expo-image', () => {
    const tr = create(
      <DisplayMediaImage
        uri="https://example.com/ok.jpg"
        width={100}
        height={100}
        alt="A mountain view"
      />,
    );
    const imgs = findExpoImages(tr.root);
    expect(imgs.length).toBeGreaterThan(0);
    expect(imgs[0].props.accessibilityLabel).toBe('A mountain view');
  });

  it('hides expo-image after onLoad (loaded phase) but shows no fallback', () => {
    const tr = create(
      <DisplayMediaImage
        uri="https://example.com/ok.jpg"
        width={100}
        height={100}
        fallbackLabel="Should not appear"
      />,
    );
    fireOnLoad(tr.root);
    // Fallback still not shown (loaded, not errored)
    expect(textContent(tr.root)).not.toContain('Should not appear');
  });
});

// ── AvatarImage ──────────────────────────────────────────────────────────────

describe('AvatarImage', () => {
  beforeEach(() => {
    // Restore default flag-OFF behaviour between tests.
    mockMediaSource.mockImplementation(async (url: string | null | undefined) =>
      url ? { uri: url } : { uri: '' },
    );
  });

  it('renders initials when uri is null and user has a name', () => {
    const tr = create(
      <AvatarImage uri={null} user={{ displayName: 'Maria Santos' }} size={40} />,
    );
    expect(textContent(tr.root)).toContain('MS');
    expect(findExpoImages(tr.root).length).toBe(0);
  });

  it('renders initials from username when displayName is absent', () => {
    const tr = create(
      <AvatarImage uri={null} user={{ username: 'alice' }} size={40} />,
    );
    // fallbackInitials('alice') → 'AL'
    expect(textContent(tr.root)).toContain('AL');
  });

  it('renders "?" when no user data at all', () => {
    const tr = create(<AvatarImage uri={null} size={40} />);
    expect(textContent(tr.root)).toContain('?');
  });

  it('renders expo-image (not initials) for a valid URL', () => {
    const tr = create(
      <AvatarImage
        uri="https://example.com/avatar.jpg"
        user={{ displayName: 'Maria Santos' }}
        size={40}
      />,
    );
    expect(findExpoImages(tr.root).length).toBeGreaterThan(0);
    // Initials not shown while image is present
    expect(textContent(tr.root)).not.toContain('MS');
  });

  it('falls back to initials after onError fires for a broken URL', () => {
    const tr = create(
      <AvatarImage
        uri="https://example.com/broken.jpg"
        user={{ displayName: 'Jordan Lee' }}
        size={40}
      />,
    );
    // Image shown initially
    expect(findExpoImages(tr.root).length).toBeGreaterThan(0);
    expect(textContent(tr.root)).not.toContain('JL');

    fireOnError(tr.root);

    // Initials shown after error
    expect(textContent(tr.root)).toContain('JL');
    expect(findExpoImages(tr.root).length).toBe(0);
  });

  it('passes relay URL + auth headers to expo-image when flag is ON', async () => {
    // Simulate flag-ON: mediaSource rewrites to the relay endpoint and adds auth.
    const relayUrl = 'https://api.example.com/api/media/file/avatars/user123.jpg';
    mockMediaSource.mockResolvedValueOnce({
      uri: relayUrl,
      headers: { Authorization: 'Bearer test-token' },
    });

    let tr!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tr = TestRenderer.create(
        <AvatarImage
          uri="https://supabase.example.com/storage/v1/object/public/avatars/user123.jpg"
          user={{ displayName: 'Alex Kim' }}
          size={40}
        />,
      );
      // Allow the mediaSource() promise to settle.
      await Promise.resolve();
    });

    const imgs = findExpoImages(tr.root);
    expect(imgs.length).toBeGreaterThan(0);
    // The source prop should use the relay URL, not the original Supabase URL.
    const src = JSON.parse(imgs[0].props['data-source'] ?? 'null') as {
      uri: string;
      headers?: Record<string, string>;
    };
    expect(src?.uri).toBe(relayUrl);
    expect(src?.headers?.Authorization).toBe('Bearer test-token');
    // Initials must not be shown.
    expect(textContent(tr.root)).not.toContain('AK');
  });

  it('never shows the previous URI relay source after uri prop changes to a new URI', async () => {
    // Simulate flag-ON for both URIs, each with distinct relay URLs.
    const relayA = 'https://api.example.com/api/media/file/avatars/a.jpg';
    const relayB = 'https://api.example.com/api/media/file/avatars/b.jpg';

    let resolveA!: (v: { uri: string; headers: { Authorization: string } }) => void;
    let resolveB!: (v: { uri: string; headers: { Authorization: string } }) => void;
    const promiseA = new Promise<{ uri: string; headers: { Authorization: string } }>(
      (res) => { resolveA = res; },
    );
    const promiseB = new Promise<{ uri: string; headers: { Authorization: string } }>(
      (res) => { resolveB = res; },
    );

    mockMediaSource
      .mockReturnValueOnce(promiseA)
      .mockReturnValueOnce(promiseB);

    let tr!: TestRenderer.ReactTestRenderer;

    // Mount with URI A — resolvedSource reset to plain { uri: uriA }.
    await act(async () => {
      tr = TestRenderer.create(
        <AvatarImage uri="https://supabase.example.com/storage/v1/object/public/avatars/a.jpg" size={40} />,
      );
    });

    // Update to URI B before A's relay promise resolves.
    await act(async () => {
      tr.update(
        <AvatarImage uri="https://supabase.example.com/storage/v1/object/public/avatars/b.jpg" size={40} />,
      );
    });

    // Now resolve A — should be ignored (cancelled).
    await act(async () => {
      resolveA({ uri: relayA, headers: { Authorization: 'Bearer token-a' } });
      await Promise.resolve();
    });

    // Source must not be the stale relay URL for A.
    const imgs = findExpoImages(tr.root);
    expect(imgs.length).toBeGreaterThan(0);
    const srcAfterA = JSON.parse(imgs[0].props['data-source'] ?? 'null') as { uri: string } | null;
    expect(srcAfterA?.uri).not.toBe(relayA);

    // Resolve B — should be applied.
    await act(async () => {
      resolveB({ uri: relayB, headers: { Authorization: 'Bearer token-b' } });
      await Promise.resolve();
    });

    const imgsAfterB = findExpoImages(tr.root);
    expect(imgsAfterB.length).toBeGreaterThan(0);
    const srcAfterB = JSON.parse(imgsAfterB[0].props['data-source'] ?? 'null') as {
      uri: string;
      headers?: Record<string, string>;
    } | null;
    expect(srcAfterB?.uri).toBe(relayB);
    expect(srcAfterB?.headers?.Authorization).toBe('Bearer token-b');
  });

  it('falls back to initials when relay returns 403 (flag ON, onError fires)', async () => {
    mockMediaSource.mockResolvedValueOnce({
      uri: 'https://api.example.com/api/media/file/avatars/private.jpg',
      headers: { Authorization: 'Bearer test-token' },
    });

    let tr!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tr = TestRenderer.create(
        <AvatarImage
          uri="https://supabase.example.com/storage/v1/object/public/avatars/private.jpg"
          user={{ displayName: 'Sam Rivera' }}
          size={40}
        />,
      );
      await Promise.resolve();
    });

    // Image is shown (relay URL in place).
    expect(findExpoImages(tr.root).length).toBeGreaterThan(0);

    // Relay returns 403 — onError fires.
    fireOnError(tr.root);

    // Initials chip shown instead of broken circle.
    expect(textContent(tr.root)).toContain('SR');
    expect(findExpoImages(tr.root).length).toBe(0);
  });
});

// ── DisplayMediaImage — mediaSource pending (first-launch auth window) ────────
//
// On first app launch the feature-flag cache is empty, so mediaSource() must
// hit /api/feature-flags before it can resolve. These tests use jest.spyOn to
// hold mediaSource in the pending state and confirm the component shows a
// skeleton (not a broken box) throughout that window.

describe('DisplayMediaImage — mediaSource pending (auth-window)', () => {
  // Hold mediaSource in "pending" state for the duration of each test so we
  // can inspect the component's appearance during the async resolution window.
  beforeEach(() => {
    jest.spyOn(MediaSourceModule, 'mediaSource').mockImplementation(
      () => new Promise(() => {}), // intentionally never resolves
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('shows skeleton — not a broken fallback box — while mediaSource is pending', () => {
    const tr = create(
      <DisplayMediaImage
        uri="https://abc123.supabase.co/storage/v1/object/public/media/img.jpg"
        width={100}
        height={100}
        fallbackLabel="Should not appear"
      />,
    );
    // The fallback must NOT be visible during the loading/pending window.
    // If the component flashed a broken box this label (or an error View)
    // would be rendered — catching the regression.
    expect(textContent(tr.root)).not.toContain('Should not appear');
  });

  it('does not render ExpoImage when resolvedSource is null (null uri)', () => {
    // A null URI means resolvedSource is initialised to null and stays null
    // even after mediaSource would have resolved — ExpoImage must never mount.
    const tr = create(
      <DisplayMediaImage uri={null} width={100} height={100} fallbackLabel="No image" />,
    );
    expect(findExpoImages(tr.root).length).toBe(0);
    expect(textContent(tr.root)).toContain('No image');
  });

  it('transitions to MediaFallback after onError (e.g. HTTP 403) — not a blank broken box', () => {
    // ExpoImage is mounted with the plain URI immediately (resolvedSource is
    // initialised synchronously so there is no blank-URI flash). If the
    // server returns 403 before the auth-bearing relay URL is ready, onError
    // fires. The component must show the designed MediaFallback — never an
    // unstyled broken-image rectangle.
    const tr = create(
      <DisplayMediaImage
        uri="https://abc123.supabase.co/storage/v1/object/public/media/img.jpg"
        width={100}
        height={100}
        fallbackLabel="Load failed"
      />,
    );
    // ExpoImage is present initially (plain URI fast-path)
    expect(findExpoImages(tr.root).length).toBeGreaterThan(0);

    // Simulate an HTTP 403 (or any network error) coming back
    fireOnError(tr.root);

    // Designed fallback is now shown
    expect(textContent(tr.root)).toContain('Load failed');
    // ExpoImage is unmounted (error phase) — no broken-image box
    expect(findExpoImages(tr.root).length).toBe(0);
  });
});
