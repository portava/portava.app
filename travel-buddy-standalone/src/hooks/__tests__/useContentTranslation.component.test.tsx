import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useContentTranslation, type ContentTranslationState } from '../useContentTranslation.ts';

let mockLanguage: string | null = 'en';
let mockUser: string | null = 'alice';
let mockPreferenceSession = 0;
const mockFetch = jest.fn();
jest.mock('../../context/LanguagePreferenceContext', () => ({ ...jest.requireActual('../../context/LanguagePreferenceContext'), useLanguagePreference: () => ({ preferredLanguage: mockLanguage, preferenceSession: mockPreferenceSession }) }));
jest.mock('../../context/SessionContext', () => ({ ...jest.requireActual('../../context/SessionContext'), useSession: () => ({ userId: mockUser }) }));
jest.mock('../../services/contentTranslation', () => ({ ...jest.requireActual('../../services/contentTranslation'), fetchContentTranslation: (...args: unknown[]) => mockFetch(...args) }));

const output = (text: string) => ({ ok: true, status: 'translated', translatedFields: { content: text }, translationLabel: 'Translated from Spanish' });
beforeEach(() => {
  mockLanguage = 'en';
  mockUser = 'alice';
  mockPreferenceSession = 0;
  mockFetch.mockReset();
});

it('does not reuse a translation when a mounted component changes entity in the same language', async () => {
  mockFetch.mockResolvedValueOnce(output('First translation')).mockResolvedValueOnce(output('Second translation'));
  const hook = await renderHook<ContentTranslationState, { id: string }>(({ id }) => useContentTranslation({ entityType: 'post', entityId: id, originalLanguage: 'es' }), { initialProps: { id: 'first' } });
  await waitFor(() => expect(hook.result.current.translatedFields.content).toBe('First translation'));
  await hook.rerender({ id: 'second' });
  await waitFor(() => expect(hook.result.current.translatedFields.content).toBe('Second translation'));
  expect(mockFetch).toHaveBeenCalledTimes(2);
});

it('returns to original immediately when the viewer clears the language preference', async () => {
  mockFetch.mockResolvedValue(output('Translation'));
  const hook = await renderHook(() => useContentTranslation({ entityType: 'post', entityId: 'one', originalLanguage: 'es' }));
  await waitFor(() => expect(hook.result.current.translated).toBe(true));
  mockLanguage = null;
  await hook.rerender({});
  expect(hook.result.current.translated).toBe(false);
  expect(hook.result.current.translatedFields).toEqual({});
  expect(hook.result.current.loading).toBe(false);
});

it('does not carry another viewer translation across a session change or logout', async () => {
  mockFetch.mockResolvedValueOnce(output('Alice result')).mockResolvedValueOnce(output('Bob result'));
  const hook = await renderHook(() => useContentTranslation({ entityType: 'post', entityId: 'one', originalLanguage: 'es' }));
  await waitFor(() => expect(hook.result.current.translatedFields.content).toBe('Alice result'));
  mockUser = 'bob';
  await hook.rerender({});
  await waitFor(() => expect(hook.result.current.translatedFields.content).toBe('Bob result'));
  mockUser = null;
  await hook.rerender({});
  expect(hook.result.current.translatedFields).toEqual({});
  expect(hook.result.current.translated).toBe(false);
});

it('does not offer a dead translation toggle when the model is unavailable', async () => {
  mockFetch.mockResolvedValue({ ok: false, status: 'failed' });
  const hook = await renderHook(() => useContentTranslation({ entityType: 'comment', entityId: 'one', originalLanguage: 'es' }));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  expect(hook.result.current.canTranslate).toBe(false);
});

it('a failed request cannot be toggled into a fabricated translation', async () => {
  mockFetch.mockResolvedValue({ ok: false, status: 'failed' });
  const hook = await renderHook(() => useContentTranslation({ entityType: 'post', entityId: 'one', originalLanguage: 'es' }));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await act(() => hook.result.current.toggle());
  expect(hook.result.current.translated).toBe(false);
});

it('discards an earlier pending response after entity change while retaining original toggle behavior', async () => {
  let finish!: (value: ReturnType<typeof output>) => void;
  mockFetch.mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(output('Current'));
  const hook = await renderHook<ContentTranslationState, { id: string }>(({ id }) => useContentTranslation({ entityType: 'post', entityId: id, originalLanguage: 'es' }), { initialProps: { id: 'old' } });
  await hook.rerender({ id: 'current' });
  await waitFor(() => expect(hook.result.current.translatedFields.content).toBe('Current'));
  await act(async () => { finish(output('Late old')); });
  expect(hook.result.current.translatedFields.content).toBe('Current');
  await act(() => hook.result.current.toggle());
  expect(hook.result.current.translated).toBe(false);
  await act(() => hook.result.current.toggle());
  expect(hook.result.current.translated).toBe(true);
});

it('immediately withholds the old result when only the provider session changes', async () => {
  mockFetch.mockResolvedValueOnce(output('Old session translation')).mockReturnValueOnce(new Promise(() => {}));
  const hook = await renderHook(() => useContentTranslation({ entityType: 'post', entityId: 'same', originalLanguage: 'es' }));
  await waitFor(() => expect(hook.result.current.translatedFields.content).toBe('Old session translation'));
  const oldToggle = hook.result.current.toggle;
  mockPreferenceSession += 1;
  await hook.rerender({});
  expect(hook.result.current.translatedFields).toEqual({});
  expect(hook.result.current.translated).toBe(false);
  expect(mockFetch).toHaveBeenCalledTimes(2);
  await act(() => oldToggle());
  expect(hook.result.current.translatedFields).toEqual({});
});

it('rejects old pending JSON after a same-owner same-language provider session replacement', async () => {
  let finish!: (value: ReturnType<typeof output>) => void;
  mockFetch.mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(output('Current session translation'));
  const hook = await renderHook(() => useContentTranslation({ entityType: 'post', entityId: 'same', originalLanguage: 'es' }));
  mockPreferenceSession += 1;
  await hook.rerender({});
  await waitFor(() => expect(hook.result.current.translatedFields.content).toBe('Current session translation'));
  await act(async () => { finish(output('Old session translation')); });
  expect(hook.result.current.translatedFields.content).toBe('Current session translation');
  expect(mockFetch).toHaveBeenCalledTimes(2);
});

it('retains an available result and original-toggle choice when the provider session remains stable', async () => {
  mockFetch.mockResolvedValue(output('Stable session translation'));
  const hook = await renderHook(() => useContentTranslation({ entityType: 'post', entityId: 'same', originalLanguage: 'es' }));
  await waitFor(() => expect(hook.result.current.translated).toBe(true));
  await act(() => hook.result.current.toggle());
  await hook.rerender({});
  expect(hook.result.current.translated).toBe(false);
  expect(hook.result.current.translatedFields.content).toBe('Stable session translation');
  expect(mockFetch).toHaveBeenCalledTimes(1);
});
