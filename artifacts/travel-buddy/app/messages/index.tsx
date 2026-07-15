import React from 'react';
import { TelegraphInboxScreen } from '../../src/components/TelegraphInboxScreen';
import { ScreenHeader } from '../../src/components/ScreenHeader';

export default function TelegraphInbox() {
  return (
    <>
      <ScreenHeader title="Messages" back />
      <TelegraphInboxScreen topInset={0} />
    </>
  );
}
