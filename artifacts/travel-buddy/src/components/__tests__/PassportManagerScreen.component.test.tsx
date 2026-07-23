/**
 * PassportManagerScreen — RNTL component tests.
 *
 * Run with: pnpm test:component
 *
 * ## Coverage
 * 1. Empty state — renders the "No passports yet" state and Add CTA.
 * 2. Non-empty list — renders a list of passport cards with country, label, and Primary badge.
 * 3. Add flow — opens the form modal, selects a country, and calls addPassport.
 * 4. Delete confirmation — pressing Delete on a non-primary passport shows Alert;
 *    confirming calls deletePassport.
 */

import React from 'react';
import { Alert } from 'react-native';
import { render, act, waitFor, screen, fireEvent } from '@testing-library/react-native';
import PassportManagerScreen from '../../../app/profile/edit/passports.tsx';
import {
  listMyPassports,
  addPassport,
  deletePassport,
} from '../../services/entryRequirements.ts';

// ── Module mocks ──────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — requireActual pulls native-module internals
// that are not safe under jest-expo.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../hooks/useNavBarCollapse', () => ({
  ...jest.requireActual('../../hooks/useNavBarCollapse'),
  NavBarFiller: () => null,
  useNavBarScrollHandler: () => () => {},
}));

// Mock the date picker so it doesn't try to load native modules
jest.mock('../DatePickerField', () => {
  const { View, Text } = require('react-native');
  return {
    DatePickerField: ({ value, placeholder }: { value: string; placeholder?: string }) => (
      <View testID="date-picker-field">
        <Text>{value || placeholder || 'Select date'}</Text>
      </View>
    ),
  };
});

// NOTE: intentionally exhaustive — the service imports supabase/fetch internals
// that fail under jest when pulled via requireActual.
jest.mock('../../services/entryRequirements', () => ({
  listMyPassports: jest.fn(),
  addPassport: jest.fn(),
  updatePassport: jest.fn(),
  deletePassport: jest.fn(),
  setTripPassport: jest.fn(),
  fetchTripEntryRequirements: jest.fn(),
}));

// ── Typed mock refs ───────────────────────────────────────────────────────────

const mockList   = listMyPassports as jest.Mock;
const mockAdd    = addPassport    as jest.Mock;
const mockDelete = deletePassport as jest.Mock;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const US_PASSPORT = {
  id: 'pp-us',
  issuingCountry: 'US',
  label: 'Main',
  expiryDate: '2030-06-15',
  isPrimary: true,
};

const PH_PASSPORT = {
  id: 'pp-ph',
  issuingCountry: 'PH',
  label: '',
  expiryDate: null,
  isPrimary: false,
};

// ── Helper ────────────────────────────────────────────────────────────────────

async function mountScreen() {
  return render(<PassportManagerScreen />);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PassportManagerScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── 1. Empty state ──────────────────────────────────────────────────────────

  it('shows empty state when there are no passports', async () => {
    mockList.mockResolvedValue([]);

    await mountScreen();

    await waitFor(() => expect(screen.getByText('No passports yet')).toBeTruthy());
    expect(screen.getByText(/Add a passport/)).toBeTruthy();
    // Privacy note visible in empty state
    expect(screen.getByText('We never store passport numbers')).toBeTruthy();
  });

  // ── 2. Non-empty list ───────────────────────────────────────────────────────

  it('renders passport cards for each passport', async () => {
    mockList.mockResolvedValue([US_PASSPORT, PH_PASSPORT]);

    await mountScreen();

    await waitFor(() => expect(screen.getByTestId('passport-card-pp-us')).toBeTruthy());

    // US passport card
    expect(screen.getByText('United States')).toBeTruthy();
    expect(screen.getByText('Main')).toBeTruthy();
    expect(screen.getByText('Primary')).toBeTruthy();

    // PH passport card
    expect(screen.getByTestId('passport-card-pp-ph')).toBeTruthy();
    expect(screen.getByText('Philippines')).toBeTruthy();
  });

  // ── 3. Add flow ─────────────────────────────────────────────────────────────

  it('opens the form modal and calls addPassport on submit', async () => {
    mockList.mockResolvedValue([]);
    mockAdd.mockResolvedValue({
      id: 'pp-new',
      issuingCountry: 'AU',
      label: 'New',
      expiryDate: null,
      isPrimary: false,
    });
    // Return updated list after add
    mockList.mockResolvedValueOnce([]).mockResolvedValue([{
      id: 'pp-new',
      issuingCountry: 'AU',
      label: 'New',
      expiryDate: null,
      isPrimary: false,
    }]);

    await mountScreen();
    await waitFor(() => expect(screen.getByText('No passports yet')).toBeTruthy());

    // Tap the header Add button
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-passport-btn'));
    });

    // Form modal should appear
    await waitFor(() => expect(screen.getByText('Add Passport')).toBeTruthy());
    expect(screen.getByTestId('privacy-note')).toBeTruthy();

    // Open country selector
    await act(async () => {
      fireEvent.press(screen.getByTestId('country-picker-btn'));
    });

    // Country selector should appear — find and press Australia
    await waitFor(() => expect(screen.getByTestId('country-option-AU')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('country-option-AU'));
    });

    // Fill in label
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('label-input'), 'New');
    });

    // Submit via the form's Save button (testID avoids ambiguity with the empty-state CTA)
    await act(async () => {
      fireEvent.press(screen.getByTestId('passport-form-save-btn'));
    });

    await waitFor(() => {
      expect(mockAdd).toHaveBeenCalledWith(
        expect.objectContaining({ issuingCountry: 'AU', label: 'New' }),
      );
    });
  });

  // ── 4. Delete confirmation ──────────────────────────────────────────────────

  it('shows Alert and calls deletePassport when confirmed for non-primary passport', async () => {
    mockList.mockResolvedValue([US_PASSPORT, PH_PASSPORT]);
    mockDelete.mockResolvedValue(true);

    const alertSpy = jest.spyOn(Alert, 'alert');

    await mountScreen();
    await waitFor(() => expect(screen.getByTestId('passport-card-pp-ph')).toBeTruthy());

    // Tap Delete on PH passport (non-primary)
    fireEvent.press(screen.getByTestId('delete-passport-pp-ph'));

    // Alert should be shown
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(
      'Delete passport?',
      expect.stringContaining('Philippines'),
      expect.any(Array),
    ));

    // Extract the destructive button and invoke it
    const buttons = alertSpy.mock.calls[0][2] as Array<{ text: string; onPress?: () => void }>;
    const deleteBtn = buttons.find((b) => b.text === 'Delete');
    expect(deleteBtn).toBeTruthy();

    deleteBtn!.onPress?.();

    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith('pp-ph');
    });

    alertSpy.mockRestore();
  });

  // ── 5. Primary passport delete guard ────────────────────────────────────────

  it('shows a guard Alert when trying to delete the primary passport', async () => {
    mockList.mockResolvedValue([US_PASSPORT]);

    const alertSpy = jest.spyOn(Alert, 'alert');

    await mountScreen();
    await waitFor(() => expect(screen.getByTestId('passport-card-pp-us')).toBeTruthy());

    fireEvent.press(screen.getByTestId('delete-passport-pp-us'));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(
      'Cannot delete primary passport',
      expect.any(String),
      expect.any(Array),
    ));

    expect(mockDelete).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });
});
