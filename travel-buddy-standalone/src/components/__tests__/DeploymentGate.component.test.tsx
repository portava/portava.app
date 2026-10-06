/**
 * DeploymentGate — with a deployment problem the app never mounts and the
 * person sees a clear error screen (verifier F4b); without one the app renders.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { Text } from 'react-native';
import { render, screen } from '@testing-library/react-native';

import { DeploymentGate } from '../DeploymentMisconfiguredScreen';

const mounted = jest.fn();
function App() {
  mounted();
  return <Text>the app</Text>;
}

beforeEach(() => mounted.mockReset());

test('a problem: the error screen, and the app never mounts', async () => {
  await render(
    <DeploymentGate problem="This build's database is beta but its API is production.">
      <App />
    </DeploymentGate>,
  );
  expect(screen.getByTestId('deployment-misconfigured')).toBeTruthy();
  expect(screen.getByText('This build is misconfigured')).toBeTruthy();
  expect(screen.getByText("This build's database is beta but its API is production.")).toBeTruthy();
  expect(screen.queryByText('the app')).toBeNull();
  expect(mounted).not.toHaveBeenCalled();
});

test('no problem: the app renders and no error screen', async () => {
  await render(
    <DeploymentGate problem={null}>
      <App />
    </DeploymentGate>,
  );
  expect(screen.getByText('the app')).toBeTruthy();
  expect(screen.queryByTestId('deployment-misconfigured')).toBeNull();
  expect(mounted).toHaveBeenCalled();
});
