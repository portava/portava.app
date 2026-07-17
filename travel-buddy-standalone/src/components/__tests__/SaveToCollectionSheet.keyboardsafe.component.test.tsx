/**
 * SaveToCollectionSheet — verifies the bottom sheet is wrapped in the
 * canonical keyboard-avoiding structure (KeyboardAvoidingView with
 * platform-correct behavior) so its inline "new collection" TextInput
 * stays above the keyboard.
 */
import React from 'react';
import { Platform, KeyboardAvoidingView } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { SaveToCollectionSheet } from '../SaveToCollectionSheet.tsx';

jest.mock('../../services/collections.ts', () => ({
  ...jest.requireActual('../../services/collections.ts'),
  getCollections: jest.fn(async () => []),
  createCollection: jest.fn(async () => null),
  saveItem: jest.fn(async () => undefined),
}));

const expectedBehavior = Platform.OS === 'ios' ? 'padding' : 'height';

it('wraps the sheet body in a KeyboardAvoidingView', async () => {
  let tr!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tr = TestRenderer.create(
      <SaveToCollectionSheet
        visible
        entityType={'place' as any}
        entityId="e1"
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
  });
  const kavs = tr.root.findAllByType(KeyboardAvoidingView);
  expect(kavs.length).toBe(1);
  expect(kavs[0].props.behavior).toBe(expectedBehavior);
  await act(async () => {
    tr.unmount();
  });
});
