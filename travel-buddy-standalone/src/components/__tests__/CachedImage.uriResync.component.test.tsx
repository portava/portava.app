/**
 * CachedImage — uri resync after an upstream pre-hydration settles
 *
 * Repro for the blank-Postcards-tile bug: a caller (PostcardTile) hydrates
 * its own display URI before handing `thumbnailUrl` to CachedImage. On the
 * caller's first render (before that hydration resolves) CachedImage mounts
 * with the RAW, unsigned private-bucket path; one render later the caller's
 * hydration settles and CachedImage receives a NEW `source.uri` — the real
 * signed URL.
 *
 * The bare path fails to load (private bucket, no scheme an <Image> can
 * fetch), so it must not be reflected in the UI once the real signed URL
 * arrives. Before the fix, only `failed` was resynced on a `uri` change;
 * `resolvedSource` stayed pinned to the stale bare path for one extra
 * render, re-triggered the load failure, and permanently latched
 * `failed = true` — even though the correct signed URL later resolved.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, screen, act } from '@testing-library/react-native';
import { CachedImage } from '../CachedImage.tsx';

const BARE_PATH = 'post-media/user-1/photo.jpg';
const SIGNED_URL =
  'https://project.supabase.co/storage/v1/object/sign/post-media/user-1/photo.jpg?token=abc';

// NOTE: intentionally exhaustive — CachedImage only uses useHydratedMedia;
// this fake mirrors its async (resolve-one-microtask-later) pass-through
// contract so the test controls resolution timing precisely.
jest.mock('../../services/mediaUrl.ts', () => ({
  useHydratedMedia: (urls: (string | null | undefined)[]) => {
    const { useState, useEffect } = require('react');
    const key = urls.filter(Boolean).join('|');
    const [resolved, setResolved] = useState<Record<string, string>>({});
    useEffect(() => {
      const list = urls.filter(Boolean) as string[];
      if (list.length === 0) {
        setResolved({});
        return;
      }
      let cancelled = false;
      Promise.resolve().then(() => {
        if (cancelled) return;
        const next: Record<string, string> = {};
        for (const u of list) next[u] = u;
        setResolved(next);
      });
      return () => {
        cancelled = true;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);
    return { resolved, loading: false };
  },
}));

// Fails any URI without an http(s) scheme — mirroring a bare private-bucket
// storage path, which a real <img>/ExpoImage cannot fetch after the bucket
// went private.
jest.mock('expo-image', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  return {
    Image: ({ source, onError, testID }: any) => {
      ReactLib.useEffect(() => {
        if (source?.uri && !/^https?:\/\//.test(source.uri)) {
          onError?.();
        }
      }, [source?.uri]);
      return ReactLib.createElement(View, { testID: testID ?? 'expo-image', source });
    },
  };
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('CachedImage — resyncs resolvedSource when uri changes', () => {
  it('renders the real signed image after a caller-side pre-hydration settles from a raw path to a signed URL', async () => {
    const { rerender } = await render(
      <CachedImage source={{ uri: BARE_PATH }} testID="tile-image" />,
    );

    // Let the bare-path load fail and this component's own identity
    // hydration for it settle.
    await flush();

    // The caller's own upstream hydration (PostcardTile) now settles and
    // hands us the real signed URL — this is the `uri` prop changing.
    rerender(<CachedImage source={{ uri: SIGNED_URL }} testID="tile-image" />);
    await flush();

    const img = screen.queryByTestId('tile-image');
    expect(img).toBeTruthy();
    expect(img?.props.source?.uri).toBe(SIGNED_URL);
  });
});
