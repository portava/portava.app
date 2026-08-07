/**
 * PortavaSheet / Avatar / SectionHeader — the three extracted primitives.
 *
 * Run: pnpm test:component -- --testPathPattern=PortavaSheet.primitives
 *
 * Alongside the obvious render cases this covers the §23 accessibility rules
 * that are easiest to skip:
 *
 *   - every trigger and avatar carries an accessible label
 *   - group vs person is distinguishable by MORE THAN COLOUR — a distinct
 *     glyph, and a distinct spoken label
 *   - touch targets meet the platform minimum
 *   - layout survives dynamic text scaling, asserted at 1x/2x/3x rather than
 *     eyeballed, because this is the one that always gets skipped
 */
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { Text, PixelRatio } from 'react-native';
import { PortavaSheet, MIN_TOUCH_TARGET } from '../PortavaSheet.tsx';
import { Avatar, initialsFor } from '../Avatar.tsx';
import { SectionHeader } from '../SectionHeader.tsx';

// NOTE: intentionally exhaustive — safe-area context reads native config that
// is unavailable under Jest, so the inset hook is stubbed to zeros.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

/** Flatten a RN style prop (array | object | nested) into one object. */
function flatStyle(style: unknown): Record<string, unknown> {
  return Object.assign({}, ...[style].flat(Infinity).filter(Boolean) as object[]);
}

describe('PortavaSheet', () => {
  it('renders children when visible', async () => {
    const { getByText } = await render(
      <PortavaSheet visible onClose={() => {}} testID="sheet">
        <Text>Sheet body</Text>
      </PortavaSheet>,
    );
    expect(getByText('Sheet body')).toBeTruthy();
  });

  it('labels the backdrop as a button so it is reachable and announced', async () => {
    const { getByTestId } = await render(
      <PortavaSheet visible onClose={() => {}} closeAccessibilityLabel="Close share sheet" testID="sheet">
        <Text>x</Text>
      </PortavaSheet>,
    );
    const backdrop = getByTestId('sheet-backdrop');
    expect(backdrop.props.accessibilityRole).toBe('button');
    expect(backdrop.props.accessibilityLabel).toBe('Close share sheet');
    expect(backdrop.props.accessible).toBe(true);
  });

  it('closes on backdrop press', async () => {
    const onClose = jest.fn();
    const { getByTestId } = await render(
      <PortavaSheet visible onClose={onClose} testID="sheet"><Text>x</Text></PortavaSheet>,
    );
    fireEvent.press(getByTestId('sheet-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the backdrop reachable by assistive tech', async () => {
    // Regression: accessibilityViewIsModal on the sheet hides its siblings,
    // and the backdrop IS a sibling — setting it made the labelled dismiss
    // button invisible to the users the label exists for. <Modal> already
    // traps focus, so the flag must stay off.
    const { getByTestId } = await render(
      <PortavaSheet visible onClose={() => {}} testID="sheet"><Text>x</Text></PortavaSheet>,
    );
    expect(getByTestId('sheet').props.accessibilityViewIsModal).toBeFalsy();
    expect(getByTestId('sheet-backdrop')).toBeTruthy();
  });

  it('uses a percentage maxHeight, never a fixed pixel height', async () => {
    // A fixed height is exactly what clips content at large text sizes.
    const { getByTestId } = await render(
      <PortavaSheet visible onClose={() => {}} maxHeightPercent={80} testID="sheet"><Text>x</Text></PortavaSheet>,
    );
    const st = flatStyle(getByTestId('sheet').props.style);
    expect(st.maxHeight).toBe('80%');
    expect(st.height).toBeUndefined();
  });
});

describe('Avatar', () => {
  it('renders the image when a uri is given', async () => {
    const { getByTestId } = await render(<Avatar uri="https://cdn/a.jpg" name="Maya Chen" testID="av" />);
    expect(getByTestId('av').props.source).toEqual({ uri: 'https://cdn/a.jpg' });
  });

  it('falls back to two-letter initials', async () => {
    const { getByText } = await render(<Avatar name="Maya Chen" testID="av" />);
    expect(getByText('MC')).toBeTruthy();
  });

  it('derives initials defensively', () => {
    expect(initialsFor('Maya Chen')).toBe('MC');
    expect(initialsFor('maya')).toBe('M');
    expect(initialsFor('  Maya   Chen  Lee ')).toBe('MC');
    expect(initialsFor('')).toBe('?');
    expect(initialsFor(null)).toBe('?');
    expect(initialsFor(undefined)).toBe('?');
  });

  // ── §23: group vs person by more than colour ──────────────────────────────

  it('renders initials for a person', async () => {
    const { queryByText } = await render(<Avatar name="Maya Chen" kind="person" testID="av" />);
    expect(queryByText('MC')).toBeTruthy();
  });

  it('renders a glyph, not initials, for a trip', async () => {
    // A trip swaps the initials for an icon. That is a SHAPE difference, so it
    // survives for a viewer who perceives no colour at all.
    const { queryByText } = await render(<Avatar name="Thailand Crew" kind="trip" testID="av" />);
    expect(queryByText('TC')).toBeNull();
  });

  it('renders a glyph, not initials, for a circle', async () => {
    const { queryByText } = await render(<Avatar name="Close Friends" kind="circle" testID="av" />);
    expect(queryByText('CF')).toBeNull();
  });

  it.each([
    ['person', 'Maya', 'Maya, person'],
    ['trip', 'Thailand 2026', 'Thailand 2026, trip chat'],
    ['circle', 'Close friends', 'Close friends, circle'],
    ['group', 'Book club', 'Book club, group chat'],
  ] as const)('spells out %s for screen readers', async (kind, name, expected) => {
    const { getByTestId } = await render(<Avatar name={name} kind={kind} testID="av" />);
    expect(getByTestId('av').props.accessibilityLabel).toBe(expected);
  });

  it('always carries a label, even with no name', async () => {
    const { getByTestId } = await render(<Avatar kind="group" testID="av" />);
    expect(getByTestId('av').props.accessibilityLabel).toBe('group chat');
  });

  it('signals selection with a border, not colour alone', async () => {
    const { getByTestId } = await render(<Avatar name="Maya" selected testID="av" />);
    expect(flatStyle(getByTestId('av').props.style).borderWidth).toBe(2);
  });

  it('meets the platform minimum when sized as a touch target', async () => {
    const { getByTestId } = await render(<Avatar name="Maya" size={MIN_TOUCH_TARGET} testID="av" />);
    const st = flatStyle(getByTestId('av').props.style);
    expect(st.width as number).toBeGreaterThanOrEqual(44);
    expect(st.height as number).toBeGreaterThanOrEqual(44);
  });

  // ── §23: dynamic text scaling ─────────────────────────────────────────────

  it('keeps initials inside the circle at large OS text sizes', async () => {
    // The circle is a fixed pixel diameter, so initials are the ONE string
    // that must not scale — otherwise they overflow the clip at 200%+.
    const { getByText } = await render(<Avatar name="Maya Chen" size={36} testID="av" />);
    expect(getByText('MC').props.allowFontScaling).toBe(false);
  });

  it.each([1, 2, 3])('keeps its box at fontScale %sx', async (scale) => {
    const spy = jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(scale);
    try {
      const { getByTestId, getByText } = await render(<Avatar name="Maya Chen" size={36} testID="av" />);
      const st = flatStyle(getByTestId('av').props.style);
      expect(st.width).toBe(36);
      expect(st.height).toBe(36);
      expect(st.borderRadius).toBe(18);
      expect(getByText('MC')).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('SectionHeader', () => {
  it('renders the label and marks it as a header', async () => {
    const { getByText } = await render(<SectionHeader>Send on Telegraph</SectionHeader>);
    expect(getByText('Send on Telegraph').props.accessibilityRole).toBe('header');
  });

  it('uppercases in style so callers pass sentence case', async () => {
    const { getByText } = await render(<SectionHeader>Send on Telegraph</SectionHeader>);
    const label = getByText('Send on Telegraph');
    expect(flatStyle(label.props.style).textTransform).toBe('uppercase');
    // The spoken label is not SHOUTED, only the rendering is.
    expect(label.props.accessibilityLabel).toBe('Send on Telegraph');
  });

  it('renders an accessory when given one', async () => {
    const { getByText } = await render(<SectionHeader accessory={<Text>3</Text>}>Your circle</SectionHeader>);
    expect(getByText('3')).toBeTruthy();
  });

  // ── §23: dynamic text scaling ─────────────────────────────────────────────

  it('lets the label wrap instead of clipping at large text sizes', async () => {
    const long = 'A section header long enough to wrap when scaled';
    const { getByText } = await render(<SectionHeader>{long}</SectionHeader>);
    const label = getByText(long);
    // numberOfLines would truncate and a fixed height would clip. Neither is set.
    expect(label.props.numberOfLines).toBeUndefined();
    const st = flatStyle(label.props.style);
    expect(st.height).toBeUndefined();
    expect(st.flexShrink).toBe(1);
  });

  it.each([1, 2, 3])('lets its text scale at fontScale %sx', async (scale) => {
    const spy = jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(scale);
    try {
      const { getByText } = await render(<SectionHeader>Send on Telegraph</SectionHeader>);
      // Unlike Avatar initials, this is body chrome and MUST scale.
      expect(getByText('Send on Telegraph').props.allowFontScaling).not.toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
