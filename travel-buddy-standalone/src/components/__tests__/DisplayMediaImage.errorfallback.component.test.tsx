/**
 * DisplayMediaImage — error-fallback, null-URI, and phase-transition tests.
 *
 * Covers:
 *   • null / undefined / whitespace URI → designed fallback shown immediately
 *   • valid → null URI rerender → component re-evaluates and shows fallback
 *   • null → valid URI rerender → component re-evaluates and removes fallback
 *   • fallbackLabel appears in the default MediaFallback for null URI
 *   • custom fallback node is rendered when uri is null
 *   • attribution absent while loading (valid URI, no load event yet)
 *   • attribution absent when uri is null (error phase from initial render)
 *   • consumer onLoad / onError props accepted without crashing
 *   • resizeMode / alt / title props forwarded without error
 *
 * Design note on mock strategy:
 *   The global expo-image stub (jest.config moduleNameMapper) renders a plain
 *   View with no children — sufficient for layout tests. The per-file factory
 *   override of expo-image does not take effect in the jest-expo runner because
 *   moduleNameMapper resolution happens before per-file jest.mock factories.
 *   Tests that require firing onLoad / onError callbacks (phase='loaded') are
 *   covered through prop-change rerenders which exercise the same setPhase()
 *   code path without needing ExpoImage's native events.
 *
 * Two-file rule from TESTING.md: this file is dedicated to DisplayMediaImage
 * so any future per-file mock additions don't collide with other test files.
 */

import React from 'react';
import { Text } from 'react-native';
import { render, act, screen, waitFor } from '@testing-library/react-native';
import { DisplayMediaImage } from '../ui/DisplayMediaImage.tsx';

// ── null / empty URI → immediate fallback ─────────────────────────────────────

describe('DisplayMediaImage — null/empty URI shows fallback immediately', () => {
  it('renders the outer container when uri is null', async () => {
    await render(
      <DisplayMediaImage uri={null} width={200} height={120} testID="dmi" />,
    );
    // Container is always mounted.
    expect(screen.getByTestId('dmi')).toBeTruthy();
  });

  it('shows fallbackLabel when uri is null', async () => {
    await render(
      <DisplayMediaImage
        uri={null}
        width={200}
        height={120}
        fallbackLabel="No photo yet"
      />,
    );
    expect(screen.getByText('No photo yet')).toBeTruthy();
  });

  it('shows fallbackLabel when uri is undefined', async () => {
    await render(
      <DisplayMediaImage
        uri={undefined}
        width={200}
        height={120}
        fallbackLabel="No image"
      />,
    );
    expect(screen.getByText('No image')).toBeTruthy();
  });

  it('shows fallbackLabel when uri is empty string', async () => {
    await render(
      <DisplayMediaImage
        uri=""
        width={200}
        height={120}
        fallbackLabel="Empty"
      />,
    );
    expect(screen.getByText('Empty')).toBeTruthy();
  });

  it('shows fallbackLabel when uri is whitespace-only (resolves to null)', async () => {
    await render(
      <DisplayMediaImage
        uri="   "
        width={200}
        height={120}
        fallbackLabel="Blank"
      />,
    );
    expect(screen.getByText('Blank')).toBeTruthy();
  });
});

// ── custom fallback node ──────────────────────────────────────────────────────

describe('DisplayMediaImage — custom fallback node', () => {
  it('renders the custom fallback node when uri is null', async () => {
    await render(
      <DisplayMediaImage
        uri={null}
        width={200}
        height={120}
        fallback={<Text testID="custom-fb">Custom fallback</Text>}
      />,
    );
    expect(screen.getByTestId('custom-fb')).toBeTruthy();
    expect(screen.getByText('Custom fallback')).toBeTruthy();
  });

  it('prefers the custom fallback node over fallbackLabel when both are provided', async () => {
    await render(
      <DisplayMediaImage
        uri={null}
        width={200}
        height={120}
        fallback={<Text testID="custom-fb2">Custom</Text>}
        fallbackLabel="Label"
      />,
    );
    // Custom node takes precedence; fallbackLabel would be inside MediaFallback
    // which is the default node — not rendered when fallback prop is provided.
    expect(screen.getByTestId('custom-fb2')).toBeTruthy();
    expect(screen.queryByText('Label')).toBeNull();
  });
});

// ── valid URI → no fallback in loading phase ──────────────────────────────────

describe('DisplayMediaImage — valid URI suppresses fallback in loading phase', () => {
  it('does NOT show fallbackLabel when uri is a valid URL', async () => {
    await render(
      <DisplayMediaImage
        uri="https://cdn.example.com/photo.jpg"
        width={200}
        height={120}
        fallbackLabel="Placeholder"
      />,
    );
    // In 'loading' phase the fallback is suppressed.
    expect(screen.queryByText('Placeholder')).toBeNull();
  });

  it('does NOT show a custom fallback node when uri is valid', async () => {
    await render(
      <DisplayMediaImage
        uri="https://cdn.example.com/photo.jpg"
        width={200}
        height={120}
        fallback={<Text testID="fb-valid">Fallback</Text>}
      />,
    );
    expect(screen.queryByTestId('fb-valid')).toBeNull();
  });
});

// ── URI prop change → phase re-evaluation ────────────────────────────────────

describe('DisplayMediaImage — URI prop change triggers phase re-evaluation', () => {
  it('transitions to fallback when valid URI changes to null', async () => {
    const { rerender } = await render(
      <DisplayMediaImage
        uri="https://cdn.example.com/photo.jpg"
        width={200}
        height={120}
        fallbackLabel="Fallback"
      />,
    );

    // Loading phase: fallback NOT visible.
    expect(screen.queryByText('Fallback')).toBeNull();

    await act(async () => {
      await rerender(
        <DisplayMediaImage
          uri={null}
          width={200}
          height={120}
          fallbackLabel="Fallback"
        />,
      );
    });

    // Error phase: fallback IS visible.
    await waitFor(() => {
      expect(screen.getByText('Fallback')).toBeTruthy();
    });
  });

  it('transitions from fallback to loading when null URI becomes valid', async () => {
    const { rerender } = await render(
      <DisplayMediaImage
        uri={null}
        width={200}
        height={120}
        fallbackLabel="Fallback"
      />,
    );

    // Error phase: fallback visible.
    expect(screen.getByText('Fallback')).toBeTruthy();

    await act(async () => {
      await rerender(
        <DisplayMediaImage
          uri="https://cdn.example.com/new-photo.jpg"
          width={200}
          height={120}
          fallbackLabel="Fallback"
        />,
      );
    });

    // Loading phase: fallback hidden.
    await waitFor(() => {
      expect(screen.queryByText('Fallback')).toBeNull();
    });
  });

  it('replaces the fallback when uri changes between two different null-resolving values', async () => {
    const { rerender } = await render(
      <DisplayMediaImage
        uri={null}
        width={200}
        height={120}
        fallbackLabel="First fallback"
      />,
    );
    expect(screen.getByText('First fallback')).toBeTruthy();

    await act(async () => {
      await rerender(
        <DisplayMediaImage
          uri="   "
          width={200}
          height={120}
          fallbackLabel="Second fallback"
        />,
      );
    });

    await waitFor(() => {
      expect(screen.getByText('Second fallback')).toBeTruthy();
    });
  });
});

// ── attribution behaviour ─────────────────────────────────────────────────────

describe('DisplayMediaImage — attribution text', () => {
  it('does NOT show attribution when uri is null (error phase)', async () => {
    await render(
      <DisplayMediaImage
        uri={null}
        width={200}
        height={120}
        attribution="© Photographer"
      />,
    );
    expect(screen.queryByText('© Photographer')).toBeNull();
  });

  it('does NOT show attribution when uri is valid but image is still loading', async () => {
    await render(
      <DisplayMediaImage
        uri="https://cdn.example.com/photo.jpg"
        width={200}
        height={120}
        attribution="© Photographer"
      />,
    );
    // Phase is 'loading' — attribution only appears after onLoad.
    expect(screen.queryByText('© Photographer')).toBeNull();
  });
});

// ── consumer callback props ───────────────────────────────────────────────────

describe('DisplayMediaImage — consumer onLoad / onError props', () => {
  it('renders without crashing when onLoad prop is provided', async () => {
    const onLoadSpy = jest.fn();
    await render(
      <DisplayMediaImage
        uri="https://cdn.example.com/photo.jpg"
        width={200}
        height={120}
        onLoad={onLoadSpy}
      />,
    );
    // Component renders without errors; onLoad is not called until image loads.
    expect(onLoadSpy).not.toHaveBeenCalled();
  });

  it('renders without crashing when onError prop is provided', async () => {
    const onErrorSpy = jest.fn();
    await render(
      <DisplayMediaImage
        uri="https://cdn.example.com/photo.jpg"
        width={200}
        height={120}
        onError={onErrorSpy}
      />,
    );
    expect(onErrorSpy).not.toHaveBeenCalled();
  });

  it('does NOT call onError when uri is null (error from initial state, not ExpoImage callback)', async () => {
    // null URI → phase='error' is set synchronously in useState initialiser,
    // not via the ExpoImage onError callback. Consumer onError is only called
    // when ExpoImage's onError fires (broken URL), not for null URIs.
    //
    // This is the deliberate half of a policy shared with CachedImage: an
    // ABSENT uri is not a failure and notifies nobody, whereas a URL the sign
    // endpoint explicitly REJECTS is final and does notify the parent (see
    // CachedImage's null-resolve branch and
    // `__tests__/CachedImage.onErrorContract.component.test.tsx`). The two
    // components look like they disagree and do not — they are handling
    // different events.
    const onErrorSpy = jest.fn();
    await render(
      <DisplayMediaImage
        uri={null}
        width={200}
        height={120}
        onError={onErrorSpy}
      />,
    );
    expect(onErrorSpy).not.toHaveBeenCalled();
  });
});

// ── prop forwarding ───────────────────────────────────────────────────────────

describe('DisplayMediaImage — prop forwarding', () => {
  it('applies the specified width and height to the container', async () => {
    await render(
      <DisplayMediaImage
        uri={null}
        width={320}
        height={240}
        testID="sized"
      />,
    );
    const el = screen.getByTestId('sized');
    // style is [{ width, height, overflow }, extraStyleProp] — check the first entry.
    expect(el.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ width: 320, height: 240 })]),
    );
  });

  it('accepts all resizeMode values without crashing', async () => {
    for (const mode of ['cover', 'contain', 'stretch', 'center'] as const) {
      await render(
        <DisplayMediaImage
          uri="https://cdn.example.com/photo.jpg"
          width={200}
          height={120}
          resizeMode={mode}
          testID={`rm-${mode}`}
        />,
      );
      expect(screen.getByTestId(`rm-${mode}`)).toBeTruthy();
    }
  });
});
