/**
 * Telegraph WP-08 — the three sheets a thread screen opens from a message or
 * from its header: Edit (TEL-F07), Edit history (TEL-F07) and Ask this
 * conversation (TEL-F16).
 *
 * One component so a thread screen mounts them with ONE line. That matters for
 * app/messages/[id].tsx, which census-telegraph cites by line number in dozens
 * of places: every line added above a citation moves it.
 *
 * The edit goes through the canonical route (`editThreadMessage`) and nothing
 * else; see messaging.ts for why the legacy `editMessage` is no longer called.
 */
import React from 'react';
import { editThreadMessage, type Message } from '../../../services/messaging.ts';
import type { SearchHit } from '../types/index.ts';
import { EditMessageSheet } from './EditMessageSheet.tsx';
import { EditHistorySheet } from './EditHistorySheet.tsx';
import { AskConversationSheet } from '../ask/AskConversationSheet.tsx';
import { editErrorCopy } from './messageActionRules.ts';

export { editErrorCopy };

export interface ThreadActionSheetsProps {
  threadId: string;
  editing: Message | null;
  onCloseEdit: () => void;
  /** Called after the server accepted an edit, with the stored body and time. */
  onEdited: (messageId: string, body: string, editedAt: string) => void;
  /**
   * Optional: a screen whose hook already owns the edit (useGroupChat.edit
   * calls the same canonical route and patches its own list) passes it here
   * instead of having this component call the route a second way.
   */
  submitEdit?: (messageId: string, body: string) => Promise<{ ok: boolean; message?: string }>;
  history: Message | null;
  onCloseHistory: () => void;
  askVisible: boolean;
  onCloseAsk: () => void;
  onOpenAskHit?: (hit: SearchHit) => void;
}

export function ThreadActionSheets({
  threadId, editing, onCloseEdit, onEdited, submitEdit, history, onCloseHistory, askVisible, onCloseAsk, onOpenAskHit,
}: ThreadActionSheetsProps) {
  return (
    <>
      <EditMessageSheet
        visible={!!editing && !!threadId}
        initialBody={editing?.body ?? ''}
        onClose={onCloseEdit}
        onSubmit={async (body) => {
          if (!editing) return { ok: false };
          if (submitEdit) return submitEdit(editing.id, body);
          const r = await editThreadMessage(threadId, editing.id, body);
          if (r.ok && r.data) {
            onEdited(editing.id, r.data.body, r.data.editedAt);
            return { ok: true };
          }
          return { ok: false, message: editErrorCopy(r.code, r.message) };
        }}
      />
      <EditHistorySheet
        visible={!!history && !!threadId}
        threadId={threadId}
        messageId={history?.id ?? ''}
        onClose={onCloseHistory}
      />
      <AskConversationSheet
        visible={askVisible && !!threadId}
        threadId={threadId}
        onClose={onCloseAsk}
        onOpenMessage={onOpenAskHit}
      />
    </>
  );
}

export default ThreadActionSheets;
