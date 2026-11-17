import React from 'react';
import { AppState } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';

let mockOwner = 'owner:session-one';
let mockAnswer: string | null = 'My trip';
let mockRows: unknown[] = [];
const mockGateway = jest.fn();
// NOTE: exhaustive hook boundary; owner replacement is driven explicitly.
jest.mock('../../../../hooks/usePrivateSurfaceKey.ts', () => ({ usePrivateSurfaceKey: () => mockOwner }));
// NOTE: exhaustive gateway hook boundary; the real writing hook and UI run.
jest.mock('../../hooks/useInputAssistance.ts', () => ({
  useInputAssistance: (opts: unknown) => {
    mockGateway(opts);
    return { suggestions: mockRows, answeredText: mockAnswer, loading: mockAnswer === null, unavailable: false };
  },
}));
import { WritingAssistControl } from '../WritingAssistControl.tsx';

const proposal = {
  id: 'draft', type: 'ai_suggestion', source: 'ai', context: 'caption', policyVersion: 'test',
  label: 'My memorable trip', replacementText: 'My memorable trip',
  action: { type: 'replace_text', text: 'My memorable trip' },
};
const props = { context: 'caption' as const, fieldId: 'post.caption', text: 'My trip', onInsert: jest.fn() };
const originalAppState = Object.getOwnPropertyDescriptor(AppState, 'currentState');
let appChange: (state: string) => void;

beforeEach(() => {
  jest.useFakeTimers();
  Object.defineProperty(AppState, 'currentState', { configurable: true, writable: true, value: 'active' });
  mockOwner = 'owner:session-one'; mockAnswer = 'My trip'; mockRows = [proposal];
  mockGateway.mockClear(); props.onInsert.mockClear();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_name, handler) => {
    appChange = handler as typeof appChange;
    return { remove: jest.fn() };
  });
});
afterEach(() => {
  if (originalAppState) Object.defineProperty(AppState, 'currentState', originalAppState);
  jest.restoreAllMocks(); jest.useRealTimers();
});

test('no request or insertion before separate explicit gestures', async () => {
  const view = await render(<WritingAssistControl {...props} />);
  expect(mockGateway).not.toHaveBeenCalled();
  await fireEvent.press(view.getByText('Refine with AI'));
  expect(mockGateway).toHaveBeenCalledWith(expect.objectContaining({ text: 'My trip', aiAssist: true }));
  expect(props.onInsert).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('AI suggestion: My memorable trip'));
  expect(props.onInsert).toHaveBeenCalledWith('My memorable trip');
  expect(view.queryByLabelText('AI suggestion: My memorable trip')).toBeNull();
});

test('edits retire the request, including returning to the original text', async () => {
  const view = await render(<WritingAssistControl {...props} />);
  await fireEvent.press(view.getByText('Refine with AI'));
  mockGateway.mockClear();
  await view.rerender(<WritingAssistControl {...props} text="New text" />);
  expect(view.queryByLabelText('AI suggestion: My memorable trip')).toBeNull();
  await view.rerender(<WritingAssistControl {...props} />);
  expect(view.queryByLabelText('AI suggestion: My memorable trip')).toBeNull();
  expect(mockGateway).not.toHaveBeenCalled();
});

test('another login and saving retire proposals without changing the field', async () => {
  const view = await render(<WritingAssistControl {...props} />);
  await fireEvent.press(view.getByText('Refine with AI'));
  mockOwner = 'owner:session-two';
  await view.rerender(<WritingAssistControl {...props} />);
  expect(view.queryByLabelText('AI suggestion: My memorable trip')).toBeNull();
  await fireEvent.press(view.getByText('Refine with AI'));
  await view.rerender(<WritingAssistControl {...props} disabled />);
  expect(view.queryByLabelText('AI suggestion: My memorable trip')).toBeNull();
  expect(props.onInsert).not.toHaveBeenCalled();
});

test('a stalled policy or request ends within the budget despite rerenders', async () => {
  mockAnswer = null; mockRows = [];
  const view = await render(<WritingAssistControl {...props} />);
  await fireEvent.press(view.getByText('Refine with AI'));
  await act(async () => { jest.advanceTimersByTime(9000); });
  await view.rerender(<WritingAssistControl {...props} maxLength={300} />);
  await act(async () => { jest.advanceTimersByTime(1000); });
  expect(view.getByText('A draft is unavailable right now. Your text has not changed.')).toBeTruthy();
  expect(props.onInsert).not.toHaveBeenCalled();
  await fireEvent.press(view.getByText('Try another draft'));
  expect(view.getByText('Drafting a suggestion…')).toBeTruthy();
});

test('backgrounding dismisses help and an empty answer has a retry affordance', async () => {
  const view = await render(<WritingAssistControl {...props} />);
  await fireEvent.press(view.getByText('Refine with AI'));
  await act(async () => { AppState.currentState = 'background'; appChange('background'); });
  expect(view.queryByLabelText('AI suggestion: My memorable trip')).toBeNull();
  mockRows = [];
  await act(async () => { AppState.currentState = 'active'; appChange('active'); });
  await fireEvent.press(view.getByText('Refine with AI'));
  expect(view.getByText('No draft is available. You can keep editing or try again.')).toBeTruthy();
});

test('stale answers and overlong output cannot replace the current draft', async () => {
  mockAnswer = 'Older text';
  const view = await render(<WritingAssistControl {...props} />);
  await fireEvent.press(view.getByText('Refine with AI'));
  expect(view.queryByLabelText('AI suggestion: My memorable trip')).toBeNull();
  mockAnswer = 'My trip';
  await view.rerender(<WritingAssistControl {...props} maxLength={5} />);
  expect(view.queryByLabelText('AI suggestion: My memorable trip')).toBeNull();
  expect(props.onInsert).not.toHaveBeenCalled();
});
