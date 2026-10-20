import React from 'react';
import { Text } from 'react-native';
import { act, render, fireEvent, waitFor } from '@testing-library/react-native';
import { TranslatedContent } from '../TranslatedContent.tsx';
import { AboutTab } from '../AboutTab.tsx';
import type { PublicProfile } from '../../types/models.ts';

const mockFetch = jest.fn();
let mockUser: string | null = 'viewer';
let mockLanguage: string | null = 'en';
jest.mock('../../services/contentTranslation', () => ({ ...jest.requireActual('../../services/contentTranslation'), fetchContentTranslation: (...args: unknown[]) => mockFetch(...args) }));
jest.mock('../../context/SessionContext', () => ({ ...jest.requireActual('../../context/SessionContext'), useSession: () => ({ userId: mockUser }) }));
jest.mock('../../context/LanguagePreferenceContext', () => ({ ...jest.requireActual('../../context/LanguagePreferenceContext'), useLanguagePreference: () => ({ preferredLanguage: mockLanguage }) }));

const result = (content: string) => ({ ok: true, status: 'translated', translatedFields: { content }, translationLabel: 'AI translation from Spanish' });
const caption = (original = 'Hola @alice #playa') => <TranslatedContent entityType="post" entityId="post" field="content" original={original}>
  <Text testID="original-caption">{original}</Text>
</TranslatedContent>;

const profile: PublicProfile = { id: 'profile-owner', username: 'traveler', displayName: 'Traveler', bio: 'Me gusta viajar',
  avatarUrl: null, homeCity: null, homeCountry: null, travelStyle: null, interests: [], verified: false,
  verificationStatus: 'unverified', verifiedAt: null, passportVisibility: 'public', createdAt: null };

it('uses the same authorized service for profile biographies and retains the original', async () => {
  mockFetch.mockResolvedValue({ ok: true, status: 'translated', translatedFields: { bio: 'I like traveling' }, translationLabel: 'AI translation from Spanish' });
  const view = await render(<AboutTab profile={profile} isOwner={false} />);
  await view.findByText('I like traveling');
  expect(mockFetch).toHaveBeenCalledWith('bio', 'profile-owner', 'en');
  await fireEvent.press(view.getByText('See original'));
  expect(view.getByText('Me gusta viajar')).toBeTruthy();
});

beforeEach(() => { mockFetch.mockReset(); mockUser = 'viewer'; mockLanguage = 'en'; });

it('uses the server language lookup, preserves originals and prevents toggle navigation', async () => {
  mockFetch.mockResolvedValue(result('Hello @alice #playa'));
  const view = await render(caption());
  await view.findByText('Hello @alice #playa');
  expect(mockFetch).toHaveBeenCalledWith('post', 'post', 'en');
  expect(view.queryByTestId('original-caption')).toBeNull();
  const stopPropagation = jest.fn();
  await fireEvent.press(view.getByText('See original'), { stopPropagation });
  expect(stopPropagation).toHaveBeenCalledTimes(1);
  expect(view.getByTestId('original-caption')).toBeTruthy();
  await fireEvent.press(view.getByText('See translation'), { stopPropagation });
  expect(view.getByText('Hello @alice #playa')).toBeTruthy();
});

it('retains original content if translation is unavailable', async () => {
  mockFetch.mockResolvedValue({ ok: false, status: 'failed' });
  const view = await render(caption());
  await waitFor(() => expect(view.queryByText('Translating…')).toBeNull());
  expect(view.getByText('Hola @alice #playa')).toBeTruthy();
  expect(view.queryByText('See original')).toBeNull();
});

it('does not translate without an authenticated viewer and language preference', async () => {
  mockUser = null;
  const view = await render(caption());
  expect(mockFetch).not.toHaveBeenCalled();
  mockUser = 'viewer'; mockLanguage = null;
  await view.rerender(caption());
  expect(mockFetch).not.toHaveBeenCalled();
  expect(view.getByTestId('original-caption')).toBeTruthy();
});

it('withdraws a prior translation when an edited caption is awaiting a fresh result', async () => {
  let resolveNew!: (value: ReturnType<typeof result>) => void;
  mockFetch.mockResolvedValueOnce(result('Old translation')).mockReturnValueOnce(new Promise(resolve => { resolveNew = resolve; }));
  const view = await render(caption('Original one'));
  await view.findByText('Old translation');
  await view.rerender(caption('Original two'));
  expect(view.queryByText('Old translation')).toBeNull();
  expect(view.getByText('Original two')).toBeTruthy();
  await act(async () => resolveNew(result('New translation')));
  await view.findByText('New translation');
});
