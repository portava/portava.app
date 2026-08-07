/**
 * Component tests for useHydratedMedia hook (mediaUrl.ts).
 *
 * Covers:
 *   - A component backed by useHydratedMedia renders the signed URL as the
 *     image source once the hook resolves.
 *   - When the resolved value is null (unauthorized) the component renders the
 *     designed fallback text, not the raw URL.
 *   - fetch is stubbed so no real network calls are made.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { Text } from 'react-native';
import { render, screen, waitFor } from '@testing-library/react-native';
import { useHydratedMedia } from '../mediaUrl.ts';
import { _resetBatchSignCache, _setTestSignTokenProvider } from '../../lib/batchSignMedia.ts';

// ── Minimal test component ────────────────────────────────────────────────────
//
// Renders the resolved URL as text (testID `resolved-<url>`) or a fallback
// label (testID `null-<url>`) so assertions can find the outcome without
// depending on any image renderer.

function HookConsumer({ url }: { url: string }) {
  const { resolved, loading } = useHydratedMedia([url]);
  const result = resolved[url]; // undefined = loading, string = ok, null = unauthorized

  if (loading || result === undefined) {
    return <Text testID="loading">loading</Text>;
  }
  if (result === null) {
    return <Text testID={`null-${url}`}>unauthorized</Text>;
  }
  return <Text testID={`resolved-${url}`}>{result}</Text>;
}

// ── fetch stubs ───────────────────────────────────────────────────────────────

let _origFetch: typeof globalThis.fetch;

function stubFetch(
  flagOn: boolean,
  signedMap: Record<string, string | null>,
) {
  (globalThis as any).fetch = async (url: string, opts?: any) => {
    if (url.includes('/api/feature-flags')) {
      return {
        ok: true,
        json: async () => ({ flags: { media_private_buckets_enabled: flagOn } }),
      };
    }
    if (url.includes('/api/media/sign')) {
      const body = opts?.body ? JSON.parse(opts.body) : { urls: [] };
      const signed: Record<string, string | null> = {};
      for (const u of body.urls as string[]) {
        signed[u] = signedMap[u] ?? null;
      }
      return { ok: true, json: async () => ({ signed, ttlSeconds: 3600 }) };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  _origFetch = globalThis.fetch;
  _resetBatchSignCache();
  _setTestSignTokenProvider(async () => 'test-access-token');
});

afterEach(() => {
  globalThis.fetch = _origFetch;
  _resetBatchSignCache();
  _setTestSignTokenProvider(null);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useHydratedMedia', () => {
  it('renders the signed URL as the source once the hook resolves', async () => {
    const postMediaUrl =
      'https://abc.supabase.co/storage/v1/object/public/post-media/img.jpg';
    const signedUrl = `${postMediaUrl}?token=abc123`;

    stubFetch(true, { [postMediaUrl]: signedUrl });

    await render(<HookConsumer url={postMediaUrl} />);

    // Wait for the async hydration to complete.
    await waitFor(() => {
      expect(screen.getByTestId(`resolved-${postMediaUrl}`)).toBeTruthy();
    });

    expect(screen.getByText(signedUrl)).toBeTruthy();
  });

  it('renders the fallback (not raw URL) when the server returns null', async () => {
    const postMediaUrl =
      'https://abc.supabase.co/storage/v1/object/public/post-media/secret.jpg';

    // Server returns null for this URL (unauthorized / bucket private).
    stubFetch(true, { [postMediaUrl]: null });

    await render(<HookConsumer url={postMediaUrl} />);

    await waitFor(() => {
      expect(screen.getByTestId(`null-${postMediaUrl}`)).toBeTruthy();
    });

    // The raw URL must NOT appear in the rendered output.
    expect(screen.queryByText(postMediaUrl)).toBeNull();
  });

  it('passes non-private-bucket URLs through unchanged without a sign request', async () => {
    const stampUrl =
      'https://abc.supabase.co/storage/v1/object/public/stamp-artwork/cat.png';

    let signCalled = false;
    (globalThis as any).fetch = async (url: string) => {
      if (url.includes('/api/feature-flags')) {
        return {
          ok: true,
          json: async () => ({ flags: { media_private_buckets_enabled: true } }),
        };
      }
      if (url.includes('/api/media/sign')) {
        signCalled = true;
        throw new Error('sign must not be called for non-private buckets');
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    await render(<HookConsumer url={stampUrl} />);

    await waitFor(() => {
      expect(screen.getByTestId(`resolved-${stampUrl}`)).toBeTruthy();
    });

    expect(signCalled).toBe(false);
    // Non-private URL is returned unchanged.
    expect(screen.getByText(stampUrl)).toBeTruthy();
  });
});
