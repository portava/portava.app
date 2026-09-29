/**
 * /settings/messages — who can message me, requests, trip/circle messaging,
 * and what read receipts do. WP-08 / TEL-F23; the screen lives in
 * src/features/telegraph/settings/MessageSettingsScreen.tsx.
 */
import React from 'react';
import { MessageSettingsScreen } from '../../src/features/telegraph/settings/MessageSettingsScreen';

export default function MessageSettingsRoute() {
  return <MessageSettingsScreen />;
}
