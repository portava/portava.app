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

// ── expo-image mock ──────────────────────────────────────────────────────────

jest.mock('expo-image', () => {
  const React = require('react');
  const { View } = require('react-native');
  // Named export "Image" — accepts onError/onLoad so we can call them in tests.
  function MockExpoImage({ onError, onLoad, accessibilityLabel, testID }: any) {
    return (
      <View
        testID={testID ?? 'mock-expo-image'}
        accessibilityLabel={accessibilityLabel}
        // Store callbacks on the node so TestRenderer can inspect them.
        onLayout={undefined}
        // Custom data props for test inspection (camelCase to avoid RN warnings)
        {...{ 'data-on-error': onError, 'data-on-load': onLoad }}
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
});
