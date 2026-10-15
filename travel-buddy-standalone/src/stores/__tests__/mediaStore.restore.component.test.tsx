import React from 'react';
import { Pressable, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { MediaStoreProvider, useMediaStore } from '../mediaStore.ts';

function deferredMode() {
  let resolve!: (mode: string | null) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string | null>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

function SelectedMode() {
  const { selectedMode, setMode } = useMediaStore();
  return (
    <View>
      <Text testID="selected-mode">{selectedMode}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Choose Watch" onPress={() => setMode('watch')}>
        <Text>Watch</Text>
      </Pressable>
    </View>
  );
}

function Surface(props: Omit<React.ComponentProps<typeof MediaStoreProvider>, 'children'>) {
  return <MediaStoreProvider {...props}><SelectedMode /></MediaStoreProvider>;
}

beforeEach(() => {
  jest.mocked(AsyncStorage.getItem).mockReset();
  jest.mocked(AsyncStorage.setItem).mockClear();
});

it('does not restore World after it becomes disabled while storage is pending', async () => {
  const stored = deferredMode();
  jest.mocked(AsyncStorage.getItem).mockReturnValue(stored.promise);
  const view = await render(<Surface defaultMode="world" enabledModes={['world', 'watch']} openOnDefault />);
  await view.rerender(<Surface defaultMode="watch" enabledModes={['watch']} />);
  expect(screen.getByTestId('selected-mode').props.children).toBe('watch');

  await act(async () => stored.resolve('world'));
  expect(screen.getByTestId('selected-mode').props.children).toBe('watch');
});

it('uses the latest World default rather than the mode policy captured before storage resolves', async () => {
  const stored = deferredMode();
  jest.mocked(AsyncStorage.getItem).mockReturnValue(stored.promise);
  const view = await render(<Surface defaultMode="watch" enabledModes={['watch', 'grid']} />);
  await view.rerender(<Surface defaultMode="world" enabledModes={['world', 'watch', 'grid']} openOnDefault />);

  await act(async () => stored.resolve('watch'));
  expect(screen.getByTestId('selected-mode').props.children).toBe('world');
});

it('keeps an explicit Watch selection made before the World default restore completes', async () => {
  const stored = deferredMode();
  jest.mocked(AsyncStorage.getItem).mockReturnValue(stored.promise);
  await render(<Surface defaultMode="world" enabledModes={['world', 'watch']} openOnDefault />);
  await fireEvent.press(screen.getByLabelText('Choose Watch'));
  expect(screen.getByTestId('selected-mode').props.children).toBe('watch');
  expect(AsyncStorage.setItem).toHaveBeenCalledWith('@travel_buddy/media_selected_mode', 'watch');

  await act(async () => stored.resolve('watch'));
  expect(screen.getByTestId('selected-mode').props.children).toBe('watch');
});

it('does not replace a user selection with the default when storage fails', async () => {
  const stored = deferredMode();
  jest.mocked(AsyncStorage.getItem).mockReturnValue(stored.promise);
  await render(<Surface defaultMode="world" enabledModes={['world', 'watch']} openOnDefault />);
  await fireEvent.press(screen.getByLabelText('Choose Watch'));

  await act(async () => stored.reject(new Error('Storage unavailable')));
  expect(screen.getByTestId('selected-mode').props.children).toBe('watch');
});

it('still restores a valid persisted mode when opening on the default is not requested', async () => {
  const stored = deferredMode();
  jest.mocked(AsyncStorage.getItem).mockReturnValue(stored.promise);
  await render(<Surface defaultMode="watch" enabledModes={['watch', 'grid']} />);

  await act(async () => stored.resolve('grid'));
  expect(screen.getByTestId('selected-mode').props.children).toBe('grid');
});

it('waits for flag inputs and falls back to their default when storage fails', async () => {
  const stored = deferredMode();
  jest.mocked(AsyncStorage.getItem).mockReturnValue(stored.promise);
  const view = await render(<Surface defaultMode="watch" enabledModes={['watch']} flagsLoading />);
  expect(AsyncStorage.getItem).not.toHaveBeenCalled();
  await view.rerender(<Surface defaultMode="world" enabledModes={['world', 'watch']} openOnDefault />);

  await act(async () => stored.reject(new Error('Storage unavailable')));
  expect(screen.getByTestId('selected-mode').props.children).toBe('world');
});
