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
 *   - useHydratedMedia signed URL → ExpoImage source updated
 *   - useHydratedMedia null → fallback shown
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

const activeRenderers = new Set<TestRenderer.ReactTestRenderer>();
function trackedCreate(element: React.ReactElement) {
  const renderer = TestRenderer.create(element);
  activeRenderers.add(renderer);
  return renderer;
}
afterEach(async () => {
  await act(async () => { for (const renderer of activeRenderers) renderer.unmount(); });
  activeRenderers.clear();
});

// ── mediaUrl mock ─────────────────────────────────────────────────────────────
// useHydratedMedia is re-implemented here using mockHydrateMediaUrls so tests
// can override the resolved URL per-test without live network access.

const mockHydrateMediaUrls = jest.fn(async (urls: string[]) => {
  const result: Record<string, string | null> = {};
  for (const u of urls) result[u] = u; // default: pass-through (flag-OFF fast path)
  return result;
});

// NOTE: intentionally exhaustive — mediaUrl.ts imports React hooks and batchSignMedia
// at module level; spreading requireActual would trigger fetch/network calls in JSDOM.
// useHydratedMedia is re-implemented here to call mockHydrateMediaUrls so individual
// tests can control the hydration result without any network calls.
jest.mock('../../../services/mediaUrl.ts', () => {
  const React = require('react');
  return {
    PRIVATE_BUCKETS: ['post-media', 'profile-media'],
    hydrateMediaUrls: (...args: any[]) => mockHydrateMediaUrls(...args),
    useHydratedMedia: (urls: (string | null | undefined)[]) => {
      const [resolved, setResolved] = React.useState<Record<string, string | null>>({});
      const [loading, setLoading] = React.useState(false);
      const key = React.useMemo(() => {
        const unique = [...new Set(urls.filter((u: any) => !!u))].sort();
        return (unique as string[]).join('\0');
      }, [urls]);
      React.useEffect(() => {
        const unique = key ? key.split('\0') : [];
        if (!unique.length) { setResolved({}); setLoading(false); return; }
        let cancelled = false;
        setLoading(true);
        mockHydrateMediaUrls(unique).then((result: Record<string, string | null>) => {
          if (!cancelled) { setResolved(result); setLoading(false); }
        });
        return () => { cancelled = true; };
      }, [key]);
      return { resolved, loading };
    },
  };
});

// Mock _evictBatchSignEntry so cache state is never mutated in tests.
const mockEvictBatchSignEntry = jest.fn();
jest.mock('../../../lib/batchSignMedia.ts', () => ({
  ...jest.requireActual('../../../lib/batchSignMedia.ts'),
  _evictBatchSignEntry: (...args: any[]) => mockEvictBatchSignEntry(...args),
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
        onLayout={undefined}
        {...{
          'data-on-error': onError,
          'data-on-load': onLoad,
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
  act(() => { tr = trackedCreate(el); });
  return tr;
}

function textContent(root: TestRenderer.ReactTestInstance): string[] {
  return root.findAllByType(Text as any).map((n) => n.props.children as string);
}

// Reset mocks to the default pass-through before every test.
beforeEach(() => {
  mockHydrateMediaUrls.mockImplementation(async (urls: string[]) => {
    const result: Record<string, string | null> = {};
    for (const u of urls) result[u] = u;
    return result;
  });
  mockEvictBatchSignEntry.mockReset();
});

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
    // Restore default pass-through behavior between tests.
    mockHydrateMediaUrls.mockImplementation(async (urls: string[]) => {
      const result: Record<string, string | null> = {};
      for (const u of urls) result[u] = u;
      return result;
    });
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

  it('updates expo-image source to signed URL once useHydratedMedia resolves', async () => {
    const originalUrl = 'https://supabase.example.com/storage/v1/object/public/profile-media/user123.jpg';
    const signedUrl = 'https://abc.supabase.co/storage/v1/object/sign/profile-media/user123.jpg?token=xxx';

    mockHydrateMediaUrls.mockResolvedValueOnce({ [originalUrl]: signedUrl });

    let tr!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tr = trackedCreate(
        <AvatarImage
          uri={originalUrl}
          user={{ displayName: 'Alex Kim' }}
          size={40}
        />,
      );
      // Allow the useHydratedMedia promise to settle.
      await Promise.resolve();
    });

    const imgs = findExpoImages(tr.root);
    expect(imgs.length).toBeGreaterThan(0);
    const src = JSON.parse(imgs[0].props['data-source'] ?? 'null') as { uri: string } | null;
    expect(src?.uri).toBe(signedUrl);
    // Initials must not be shown.
    expect(textContent(tr.root)).not.toContain('AK');
  });

  it('never shows the previous signed URL after uri prop changes to a new URI', async () => {
    const uriA = 'https://supabase.example.com/storage/v1/object/public/profile-media/a.jpg';
    const uriB = 'https://supabase.example.com/storage/v1/object/public/profile-media/b.jpg';
    const signedA = `${uriA}?token=a`;
    const signedB = `${uriB}?token=b`;

    let resolveA!: (v: Record<string, string | null>) => void;
    let resolveB!: (v: Record<string, string | null>) => void;

    mockHydrateMediaUrls
      .mockImplementationOnce((_urls: string[]) => new Promise((res) => { resolveA = res; }))
      .mockImplementationOnce((_urls: string[]) => new Promise((res) => { resolveB = res; }));

    let tr!: TestRenderer.ReactTestRenderer;

    // Mount with URI A.
    await act(async () => {
      tr = trackedCreate(<AvatarImage uri={uriA} size={40} />);
    });

    // Update to URI B before A's promise resolves.
    await act(async () => {
      tr.update(<AvatarImage uri={uriB} size={40} />);
    });

    // Resolve A — should be ignored (cancelled effect).
    await act(async () => {
      resolveA({ [uriA]: signedA });
      await Promise.resolve();
    });

    // A private avatar waits for B's authorization; neither A nor an unsigned
    // B URL may be mounted while the second request is pending.
    expect(findExpoImages(tr.root)).toHaveLength(0);

    // Resolve B — should be applied.
    await act(async () => {
      resolveB({ [uriB]: signedB });
      await Promise.resolve();
    });

    const imgsAfterB = findExpoImages(tr.root);
    expect(imgsAfterB.length).toBeGreaterThan(0);
    const srcAfterB = JSON.parse(imgsAfterB[0].props['data-source'] ?? 'null') as { uri: string } | null;
    expect(srcAfterB?.uri).toBe(signedB);
  });

  it('falls back to initials when onError fires for a non-private-bucket URL', async () => {
    // avatars bucket is NOT in PRIVATE_BUCKETS — no re-hydration attempt is made,
    // the component falls back to initials immediately on the first error.
    const url = 'https://supabase.example.com/storage/v1/object/public/avatars/private.jpg';
    mockHydrateMediaUrls.mockResolvedValueOnce({ [url]: url });

    let tr!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tr = trackedCreate(
        <AvatarImage
          uri={url}
          user={{ displayName: 'Sam Rivera' }}
          size={40}
        />,
      );
      await Promise.resolve();
    });

    // Image is shown.
    expect(findExpoImages(tr.root).length).toBeGreaterThan(0);

    // onError fires — not a private bucket, so initials shown immediately.
    fireOnError(tr.root);

    expect(textContent(tr.root)).toContain('SR');
    expect(findExpoImages(tr.root).length).toBe(0);
  });
});

// ── DisplayMediaImage — 403 → evict → re-hydrate → success ────────────────────

describe('DisplayMediaImage — 403 re-hydrate sequence', () => {
  it('evicts cache entry and retries with a fresh signed URL after a 403 on a post-media URL', async () => {
    const originalUrl =
      'https://supabase.example.com/storage/v1/object/public/post-media/photo.jpg';
    const freshSignedUrl =
      'https://abc.supabase.co/storage/v1/object/sign/post-media/photo.jpg?token=fresh';

    // Call 1: initial useHydratedMedia hook resolution (pass-through when flag OFF)
    // Call 2: hydrateMediaUrls called directly by handleError after the 403
    mockHydrateMediaUrls
      .mockResolvedValueOnce({ [originalUrl]: originalUrl })
      .mockResolvedValueOnce({ [originalUrl]: freshSignedUrl });

    let tr!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tr = trackedCreate(
        <DisplayMediaImage
          uri={originalUrl}
          width={200}
          height={200}
          fallbackLabel="load-failed"
        />,
      );
      // Allow the initial useHydratedMedia promise to settle.
      await Promise.resolve();
    });

    // Image should be mounted (loading phase, not error).
    expect(findExpoImages(tr.root).length).toBeGreaterThan(0);
    expect(textContent(tr.root)).not.toContain('load-failed');

    // Simulate a 403 / onError event on the ExpoImage.
    await act(async () => {
      const imgs = findExpoImages(tr.root);
      const cb = imgs[0].props['data-on-error'];
      cb();
      // Flush the re-hydration promise chain (two microtask ticks).
      await Promise.resolve();
      await Promise.resolve();
    });

    // _evictBatchSignEntry must have been called with the original URL.
    expect(mockEvictBatchSignEntry).toHaveBeenCalledWith(originalUrl);

    // The component should NOT be showing the error fallback — it received a
    // fresh signed URL and updated its source.
    expect(textContent(tr.root)).not.toContain('load-failed');

    // ExpoImage should still be mounted with the fresh signed URL.
    const imgs = findExpoImages(tr.root);
    expect(imgs.length).toBeGreaterThan(0);
    const src = JSON.parse(imgs[0].props['data-source'] ?? 'null') as { uri: string } | null;
    expect(src?.uri).toBe(freshSignedUrl);
  });

  it('transitions to fallback when re-hydration returns null for the post-media URL', async () => {
    const originalUrl =
      'https://supabase.example.com/storage/v1/object/public/post-media/gone.jpg';

    mockHydrateMediaUrls
      .mockResolvedValueOnce({ [originalUrl]: originalUrl }) // initial hook
      .mockResolvedValueOnce({ [originalUrl]: null });        // re-hydration → null (server rejected)

    let tr!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tr = trackedCreate(
        <DisplayMediaImage
          uri={originalUrl}
          width={200}
          height={200}
          fallbackLabel="rejected"
        />,
      );
      await Promise.resolve();
    });

    // Image shown initially.
    expect(findExpoImages(tr.root).length).toBeGreaterThan(0);

    // Simulate 403.
    await act(async () => {
      const cb = findExpoImages(tr.root)[0].props['data-on-error'];
      cb();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Server returned null → fallback shown.
    expect(textContent(tr.root)).toContain('rejected');
    expect(findExpoImages(tr.root).length).toBe(0);
  });
});

// ── DisplayMediaImage — hydrateMediaUrls loading (auth-window) ────────────────
//
// While useHydratedMedia is in-flight (e.g. feature-flag cache is cold on first
// launch), the component must show a skeleton — never a broken box or fallback.

describe('DisplayMediaImage — hydrateMediaUrls loading (auth-window)', () => {
  // Hold hydrateMediaUrls in "pending" state for the duration of each test so
  // we can inspect the component's appearance during the async resolution window.
  beforeEach(() => {
    mockHydrateMediaUrls.mockImplementation(() => new Promise(() => {})); // never resolves
  });

  afterEach(() => {
    // Restore default pass-through behavior.
    mockHydrateMediaUrls.mockImplementation(async (urls: string[]) => {
      const result: Record<string, string | null> = {};
      for (const u of urls) result[u] = u;
      return result;
    });
  });

  it('shows skeleton — not a broken fallback box — while hydrateMediaUrls is pending', () => {
    const tr = create(
      <DisplayMediaImage
        uri="https://example.com/img.jpg"
        width={100}
        height={100}
        fallbackLabel="Should not appear"
      />,
    );
    // The fallback must NOT be visible during the loading/pending window.
    expect(textContent(tr.root)).not.toContain('Should not appear');
    // ExpoImage IS mounted with the synchronously-initialised plain URI.
    expect(findExpoImages(tr.root).length).toBeGreaterThan(0);
  });

  it('does not render ExpoImage when resolvedSource is null (null uri)', () => {
    // A null URI means resolvedSource is initialised to null — ExpoImage never mounts.
    const tr = create(
      <DisplayMediaImage uri={null} width={100} height={100} fallbackLabel="No image" />,
    );
    expect(findExpoImages(tr.root).length).toBe(0);
    expect(textContent(tr.root)).toContain('No image');
  });

  it('transitions to MediaFallback after onError for a non-private-bucket URL', () => {
    // For URLs outside post-media / profile-media (e.g. CDN, Unsplash) the
    // component never attempts re-hydration; it transitions to error immediately.
    const tr = create(
      <DisplayMediaImage
        uri="https://example.com/img.jpg"
        width={100}
        height={100}
        fallbackLabel="Load failed"
      />,
    );
    // ExpoImage is present initially (plain URI fast-path)
    expect(findExpoImages(tr.root).length).toBeGreaterThan(0);

    // Simulate HTTP 403 / any network error
    fireOnError(tr.root);

    // Designed fallback is now shown
    expect(textContent(tr.root)).toContain('Load failed');
    // ExpoImage is unmounted (error phase) — no broken-image box
    expect(findExpoImages(tr.root).length).toBe(0);
  });
});

// Races exercise the real source/viewer lifecycle; only signing and native image
// events are substituted. No old request may set a recycled tile's source.
import { _resetDiscoveryViewerScopeForTests, setDiscoveryViewerFromSession } from '../../../services/discoveryViewerScope.ts';

describe('media render ownership and bounded recovery', () => {
  let tree: TestRenderer.ReactTestRenderer | null = null;
  const uriA = 'post-media/alice/a.jpg';
  const uriB = 'post-media/alice/b.jpg';
  beforeEach(() => { jest.useFakeTimers(); _resetDiscoveryViewerScopeForTests(); });
  afterEach(async () => {
    await act(async () => { tree?.unmount(); }); tree = null;
    jest.useRealTimers();
  });
  const mount = async (uri: string, onError = jest.fn()) => {
    await act(async () => { tree = trackedCreate(<DisplayMediaImage uri={uri} width={180} height={180} onError={onError} />); });
  };

  it('waits for private media authorization instead of mounting an unsigned path', async () => {
    let resolve!: (value: Record<string, string | null>) => void;
    mockHydrateMediaUrls.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    await mount(uriA);
    expect(findExpoImages(tree!.root)).toHaveLength(0);
    await act(async () => { resolve({ [uriA]: 'https://storage.test/authorized' }); });
    expect(findExpoImages(tree!.root)[0].props['data-source']).toContain('authorized');
  });

  it('late re-signing and native load events from A cannot change recycled tile B', async () => {
    let resolveA!: (value: Record<string, string | null>) => void;
    mockHydrateMediaUrls.mockResolvedValueOnce({ [uriA]: 'https://storage.test/old-a' })
      .mockImplementationOnce(() => new Promise(r => { resolveA = r; }))
      .mockResolvedValueOnce({ [uriB]: 'https://storage.test/current-b' });
    const onLoad = jest.fn();
    await act(async () => { tree = trackedCreate(<DisplayMediaImage uri={uriA} width={180} height={180} onLoad={onLoad} />); });
    const old = findExpoImages(tree!.root)[0].props;
    await act(async () => { old['data-on-error'](); });
    await act(async () => { tree!.update(<DisplayMediaImage uri={uriB} width={180} height={180} onLoad={onLoad} />); });
    await act(async () => { resolveA({ [uriA]: 'https://storage.test/late-a' }); old['data-on-load'](); });
    expect(findExpoImages(tree!.root)[0].props['data-source']).toContain('current-b');
    expect(onLoad).not.toHaveBeenCalled();
  });

  it('account replacement removes the old private image and ignores its pending retry', async () => {
    let resolveA!: (value: Record<string, string | null>) => void;
    let resolveB!: (value: Record<string, string | null>) => void;
    mockHydrateMediaUrls.mockResolvedValueOnce({ [uriA]: 'https://storage.test/alice' })
      .mockImplementationOnce(() => new Promise(r => { resolveA = r; }))
      .mockImplementationOnce(() => new Promise(r => { resolveB = r; }));
    await mount(uriA);
    await act(async () => { findExpoImages(tree!.root)[0].props['data-on-error'](); });
    await act(async () => { setDiscoveryViewerFromSession('bob'); });
    expect(findExpoImages(tree!.root)).toHaveLength(0);
    await act(async () => { resolveA({ [uriA]: 'https://storage.test/late-alice' }); });
    expect(findExpoImages(tree!.root)).toHaveLength(0);
    await act(async () => { resolveB({ [uriA]: null }); });
    expect(textContent(tree!.root)).toContain('Image unavailable');
  });

  it('a stalled image becomes retryable after 12 seconds and an explicit retry can recover', async () => {
    let resolveOld!: (value: Record<string, string | null>) => void;
    const onError = jest.fn();
    mockHydrateMediaUrls.mockImplementationOnce(() => new Promise(r => { resolveOld = r; }))
      .mockResolvedValueOnce({ [uriA]: 'https://storage.test/retry' });
    await mount(uriA, onError);
    await act(async () => { await jest.advanceTimersByTimeAsync(12_000); });
    expect(textContent(tree!.root)).toContain('Image unavailable');
    expect(onError).toHaveBeenCalledTimes(1);
    await act(async () => { resolveOld({ [uriA]: 'https://storage.test/too-late' }); });
    expect(findExpoImages(tree!.root)).toHaveLength(0);
    await act(async () => { tree!.root.findAllByProps({ accessibilityLabel: 'Retry image' })[0].props.onPress(); });
    expect(findExpoImages(tree!.root)[0].props['data-source']).toContain('retry');
    await act(async () => { findExpoImages(tree!.root)[0].props['data-on-load'](); });
    expect(textContent(tree!.root)).not.toContain('Image unavailable');
  });

  it('a rejected re-sign promise is handled once and cannot leave a skeleton indefinitely', async () => {
    const onError = jest.fn();
    mockHydrateMediaUrls.mockResolvedValueOnce({ [uriA]: 'https://storage.test/expired' })
      .mockRejectedValueOnce(new Error('network reset'));
    await mount(uriA, onError);
    await act(async () => { findExpoImages(tree!.root)[0].props['data-on-error'](); });
    expect(textContent(tree!.root)).toContain('Image unavailable');
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
