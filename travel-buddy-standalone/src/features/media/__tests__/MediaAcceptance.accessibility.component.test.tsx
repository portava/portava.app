import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { MediaContributionSheet } from '../components/MediaContributionSheet.tsx';
import { MediaWorldHeader } from '../components/MediaWorldHeader.tsx';
import {
  contributionReducer,
  INITIAL_CONTRIBUTION_DRAFT,
  type ContributionAction,
  type ContributionDraft,
} from '../state/mediaContribution.ts';

function contribution(
  busy: boolean,
  dispatch: (action: ContributionAction) => void = jest.fn(),
  draft: ContributionDraft = INITIAL_CONTRIBUTION_DRAFT,
) {
  return (
    <MediaContributionSheet
      placeName="Acceptance place"
      draft={draft}
      dispatch={dispatch}
      onPickMedia={jest.fn()}
      onSubmit={jest.fn()}
      blocker={null}
      busy={busy}
    />
  );
}

test('MD403: the submit action retains its accessible name while upload is busy', async () => {
  const view = await render(contribution(false));
  expect(screen.getByRole('button', { name: 'Share this perspective' })).toBeTruthy();
  await view.rerender(contribution(true));
  expect(screen.getByTestId('media-contribution-submit').props.accessibilityState.disabled).toBe(true);
  expect(screen.getByTestId('media-contribution-submit').props.accessibilityState.busy).toBe(true);
  expect(screen.getByRole('button', { name: 'Share this perspective' })).toBeTruthy();
  await view.rerender(contribution(false));
  expect(screen.getByRole('button', { name: 'Share this perspective' }).props.accessibilityState).toMatchObject({ disabled: false, busy: false });
});

test('MD403: World icon actions are discoverable as named buttons', async () => {
  await render(<MediaWorldHeader cityName="Acceptance city" onSearch={jest.fn()} onCompass={jest.fn()} />);
  expect(screen.getByLabelText('Search media')).toBeTruthy();
  expect(screen.getByLabelText('Ask Compass')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Search media' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Ask Compass' })).toBeTruthy();
});

test('privacy controls expose and retain the selected restrictive choices', async () => {
  function ControlledContribution() {
    const [draft, dispatch] = React.useReducer(contributionReducer, INITIAL_CONTRIBUTION_DRAFT);
    return contribution(false, dispatch, draft);
  }
  await render(<ControlledContribution />);
  expect(screen.getByRole('button', { name: 'Everyone' }).props.accessibilityState.selected).toBe(true);
  const privateAudience = screen.getByRole('button', { name: 'Only me' });
  expect(privateAudience.props.accessibilityState.selected).toBe(false);
  await fireEvent.press(privateAudience);
  expect(screen.getByRole('button', { name: 'Only me' }).props.accessibilityState.selected).toBe(true);
  expect(screen.getByRole('button', { name: 'Everyone' }).props.accessibilityState.selected).toBe(false);
  await fireEvent.press(screen.getByTestId('media-contribution-precision-hidden'));
  expect(screen.getByTestId('media-contribution-precision-hidden').props.accessibilityState.selected).toBe(true);
  expect(screen.getByTestId('media-contribution-precision-venue').props.accessibilityState.selected).toBe(false);
});

test('unoffered privacy and vantage gates do not appear as controls', async () => {
  await render(contribution(false));
  expect(screen.queryByTestId('media-contribution-precision-neighborhood')).toBeNull();
  expect(screen.queryByText('Where in the place?')).toBeNull();
});
