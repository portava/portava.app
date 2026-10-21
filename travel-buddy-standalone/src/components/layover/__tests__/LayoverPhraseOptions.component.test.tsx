import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { LayoverPhraseOptions } from '../LayoverPhraseOptions.tsx';
test('the traveller can choose another cached language and see the named stop in that language', async () => {
  const english = { key: 'please_help', english: 'Please help me.', local: 'Please help me.' };
  await render(<LayoverPhraseOptions set={{ language: 'en', languageName: 'English', phrases: [english], languageOptions: [
    { language: 'en', languageName: 'English', phrases: [english], stops: [] },
    { language: 'fr', languageName: 'French', phrases: [{ ...english, local: "Aidez-moi, s'il vous plaît." }], stops: [{ stopTitle: 'Garden', phrases: [{ key: 'where_is_stop', english: 'Where is Garden?', local: 'Où se trouve Garden ?' }] }] },
  ] }} />);
  await fireEvent.press(screen.getByTestId('layover-phrase-language-fr'));
  expect(screen.getByText('Où se trouve Garden ?')).toBeTruthy();
  expect(screen.getByText('Where is Garden?')).toBeTruthy();
  expect(screen.getByText('Place names are unchanged. Native-speaker review is pending.')).toBeTruthy();
});
