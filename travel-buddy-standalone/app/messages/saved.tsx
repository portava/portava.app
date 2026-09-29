/**
 * /messages/saved — the messages this person saved, re-authorized by the server
 * on every read. WP-08 / TEL-F08; the screen lives in
 * src/features/telegraph/savedMessages/SavedMessagesScreen.tsx.
 *
 * A static segment beside `[id].tsx`: Expo Router matches `saved` here before
 * it would treat it as a thread id.
 */
import React from 'react';
import { SavedMessagesScreen } from '../../src/features/telegraph/savedMessages/SavedMessagesScreen';

export default function SavedMessagesRoute() {
  return <SavedMessagesScreen />;
}
