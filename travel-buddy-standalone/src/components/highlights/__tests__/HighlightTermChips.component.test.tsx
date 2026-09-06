/**
 * HighlightTermChips — the permanence vocabulary.
 *
 * Owner ruling 2026-09-06: a Highlight may be permanent. `null` hours is the
 * permanent term, and it has to survive the whole way from the chip the user
 * presses to the value the caller sends — a chip that yields 0, undefined, or
 * a very large number instead of `null` would quietly re-introduce an expiry.
 *
 * The other half of the ruling is that `expires_at === null` must never reach
 * a date formatter. formatHighlightExpiry is the one place that decides, so
 * that decision is pinned here.
 *
 * The chips are tested directly rather than through HighlightComposer, which
 * pulls in expo-av / Supabase singletons that leak timers under Jest — the
 * same reason HighlightComposer.reopenPreservesMedia uses a wrapper.
 */
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import {
  HighlightTermChips,
  HIGHLIGHT_TERMS,
  DEFAULT_HIGHLIGHT_TERM_HOURS,
  describeHighlightTerm,
  formatHighlightExpiry,
} from '../HighlightTermChips.tsx';

describe('HighlightTermChips — permanence is a value, not a missing choice', () => {
  it('offers a Never option whose term is null', () => {
    const never = HIGHLIGHT_TERMS.find((d) => d.label === 'Never');
    expect(never).toBeDefined();
    expect(never!.hours).toBeNull();
  });

  it('keeps the five dated terms the server accepts', () => {
    const dated = HIGHLIGHT_TERMS.filter((d) => d.hours !== null).map((d) => d.hours);
    expect(dated).toEqual([3, 6, 12, 24, 48]);
  });

  it('defaults to 24h — permanence is never inherited', () => {
    expect(DEFAULT_HIGHLIGHT_TERM_HOURS).toBe(24);
  });

  it('pressing Never reports null, not 0 or undefined', async () => {
    const onChange = jest.fn();
    const { getByText } = await render(
      <HighlightTermChips value={DEFAULT_HIGHLIGHT_TERM_HOURS} onChange={onChange} />,
    );

    fireEvent.press(getByText('Never'));

    expect(onChange).toHaveBeenCalledTimes(1);
    const [reported] = onChange.mock.calls[0];
    expect(reported).toBeNull();
    // toBeNull passes for null only, but spell out the failure this guards:
    // an `?? 24` further down the chain turns undefined into a 24h term.
    expect(reported).not.toBeUndefined();
  });

  it('pressing a dated chip still reports that number of hours', async () => {
    const onChange = jest.fn();
    const { getByText } = await render(<HighlightTermChips value={null} onChange={onChange} />);

    fireEvent.press(getByText('48h'));

    expect(onChange).toHaveBeenCalledWith(48);
  });

  it('does not report a change while disabled', async () => {
    const onChange = jest.fn();
    const { getByText } = await render(
      <HighlightTermChips value={24} onChange={onChange} disabled />,
    );

    fireEvent.press(getByText('Never'));

    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('a permanent highlight reads as permanent, never as a broken date', () => {
  it('formats a null expiry without touching Date', () => {
    const text = formatHighlightExpiry(null);
    expect(text).toBe('Always on');
    expect(text).not.toMatch(/NaN|Invalid/i);
  });

  it('still counts down a real expiry', () => {
    const inThreeHours = new Date(Date.now() + 3 * 3600_000 + 60_000).toISOString();
    expect(formatHighlightExpiry(inThreeHours)).toBe('3h left');
  });

  it('describes the permanent term as lasting, and a dated one as expiring', () => {
    expect(describeHighlightTerm(null)).toMatch(/never expires/i);
    expect(describeHighlightTerm(null)).not.toMatch(/\d+ hours/);
    expect(describeHighlightTerm(24)).toMatch(/24 hours/);
  });
});
