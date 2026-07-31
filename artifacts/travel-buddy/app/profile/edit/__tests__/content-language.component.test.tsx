/**
 * ContentLanguageScreen — picker selection and save tests.
 *
 * Run with: pnpm test:component
 *
 * ## What's covered
 *
 * 1. The row matching the user's current preferredLanguage shows a Check icon.
 * 2. All other rows have no Check icon.
 * 3. Tapping a different row calls updateLanguage with the correct language code.
 * 4. Tapping 'Use device language' calls updateLanguage with null.
 *
 * ## Why these tests exist
 *
 * ContentLanguageScreen reads from LanguagePreferenceContext and calls
 * updateLanguage on selection. A regression could break the current-selection
 * indicator (Check icon missing or on the wrong row), or pass the wrong code
 * / omit the call entirely when the user picks a new language.
 */

import React from 'react';
import { render, act, waitFor, fireEvent, cleanup, screen, within } from '@testing-library/react-native';
import ContentLanguageScreen from '../content-language.tsx';

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// Mock the context hook — controls what the screen sees as the current selection.
const mockUpdateLanguage = jest.fn();

jest.mock('../../../../src/context/LanguagePreferenceContext', () => ({
  ...jest.requireActual('../../../../src/context/LanguagePreferenceContext'),
  useLanguagePreference: () => ({
    preferredLanguage: mockPreferredLanguage,
    loading: false,
    updateLanguage: mockUpdateLanguage,
  }),
}));

// Module-level variable so individual tests can override it before render.
let mockPreferredLanguage: string | null = 'en';

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
  mockPreferredLanguage = 'en';
});

describe('ContentLanguageScreen — language picker', () => {
  it('shows a Check icon only on the currently selected language row', async () => {
    mockPreferredLanguage = 'es';

    await render(<ContentLanguageScreen />);

    // Exactly one Check icon in the list (not on any other row).
    await waitFor(() => expect(screen.getAllByTestId('icon-Check')).toHaveLength(1));

    // The selected row (Spanish) has the Check icon inside it.
    const spanishRow = screen.getByTestId('lang-option-es');
    expect(within(spanishRow).queryByTestId('icon-Check')).not.toBeNull();

    // An unselected row (English) has no Check icon.
    const englishRow = screen.getByTestId('lang-option-en');
    expect(within(englishRow).queryByTestId('icon-Check')).toBeNull();
  });

  it('calls updateLanguage with the correct code when a new language is tapped', async () => {
    mockPreferredLanguage = 'en';
    mockUpdateLanguage.mockResolvedValue({ ok: true });

    await render(<ContentLanguageScreen />);

    // English is currently selected — Check is visible.
    await waitFor(() => expect(screen.getByTestId('icon-Check')).toBeTruthy());

    // Tap French.
    await act(async () => {
      fireEvent.press(screen.getByTestId('lang-option-fr'));
    });

    expect(mockUpdateLanguage).toHaveBeenCalledTimes(1);
    expect(mockUpdateLanguage).toHaveBeenCalledWith('fr');
  });

  it('calls updateLanguage with null when "Use device language" is tapped', async () => {
    mockPreferredLanguage = 'en';
    mockUpdateLanguage.mockResolvedValue({ ok: true });

    await render(<ContentLanguageScreen />);

    await waitFor(() => expect(screen.getByTestId('lang-option-none')).toBeTruthy());

    await act(async () => {
      fireEvent.press(screen.getByTestId('lang-option-none'));
    });

    expect(mockUpdateLanguage).toHaveBeenCalledTimes(1);
    expect(mockUpdateLanguage).toHaveBeenCalledWith(null);
  });

  it('does not call updateLanguage when the already-selected row is tapped again', async () => {
    mockPreferredLanguage = 'de';
    mockUpdateLanguage.mockResolvedValue({ ok: true });

    await render(<ContentLanguageScreen />);

    await waitFor(() => expect(screen.getByTestId('lang-option-de')).toBeTruthy());

    await act(async () => {
      fireEvent.press(screen.getByTestId('lang-option-de'));
    });

    expect(mockUpdateLanguage).not.toHaveBeenCalled();
  });
});
