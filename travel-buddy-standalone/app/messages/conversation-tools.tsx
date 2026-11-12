import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { ConversationTools, type ConversationToolMode } from '../../src/features/telegraph/management/ConversationTools.tsx';
export default function ConversationToolsScreen() {
  const { threadId, messageId, mode } = useLocalSearchParams<{ threadId: string; messageId?: string; mode: string }>();
  const validMode: ConversationToolMode = mode === 'add' || mode === 'forward' || mode === 'permission' ? mode : 'manage';
  return <ConversationTools threadId={threadId ?? ''} messageId={messageId} mode={validMode} />;
}
